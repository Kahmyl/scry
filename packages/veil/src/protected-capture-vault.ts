import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { readFile, readdir, unlink } from "node:fs/promises";
import path from "node:path";
import type {
  BrowserCaptureNode,
  BrowserCaptureReceipt,
  BrowserOutputSelection,
  BrowserPublishedOutputs,
} from "@scry/contracts";
import {
  browserCaptureReceiptSchema,
  browserOutputSelectionSchema,
  browserPublishedOutputsSchema,
} from "@scry/contracts";
import {
  ProtectionAuthority,
  type ProtectionBarrierToken,
  type ProtectionCandidate,
  type ProtectionDecision,
  type ProtectionProposal,
} from "./protection-authority.js";
import { durableWrite, ensurePrivateDirectory, isNodeError } from "./capture-storage.js";

const DEFAULT_CAPTURE_LIMIT = 64 * 1024;
const DEFAULT_OPERATION_LIMIT = 512 * 1024;
const DEFAULT_RETENTION_MS = 15 * 60 * 1_000;
const MAX_PUBLISHED_OUTPUTS = 100;

type JsonScalar = string | number | boolean | null;
type JsonPathSegment = string | number;

interface EncryptedRecord {
  aad: Record<string, unknown>;
  nonce: string;
  ciphertext: string;
  tag: string;
  digest: string;
}

interface StoredReceipt extends BrowserCaptureReceipt {
  rawDigest: string;
  protectionBarrier: ProtectionBarrierToken;
  selectionDigest?: string;
  publishedOutputs?: BrowserPublishedOutputs;
  stringLineageKeys?: string[];
  publicationBarrier?: ProtectionBarrierToken;
}

export interface DurableCaptureEnvelope {
  captureId: string;
  storedReceipt: Record<string, unknown>;
  encryptedPayload: Buffer;
  encryptedPayloadDigest: string;
}

export interface DiscardedCaptureProtection {
  receipt: BrowserCaptureReceipt;
}

export interface HttpResponseCaptureInput {
  effectId: string;
  method: string;
  url: string;
  status: number;
  contentType: string;
  body: Buffer;
  redirectChain?: Array<{
    status: number;
    sameOrigin: boolean;
    targetDigest: string;
  }>;
  capturedAt?: Date;
  protectionBarrier: ProtectionBarrierToken;
}

export interface ProtectedBrowserSink {
  fill(value: string): Promise<void>;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

type HttpContentClass = BrowserCaptureReceipt["contentClass"];

function classifyHttpContent(
  contentType: string,
  body: Buffer,
): {
  contentClass: HttpContentClass;
  parsed?: unknown;
} {
  if (body.length === 0) return { contentClass: "http_empty" };
  const mediaType = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (mediaType === "application/vnd.scry.dom+json") {
    try {
      return { contentClass: "dom_region", parsed: JSON.parse(body.toString("utf8")) as unknown };
    } catch {
      throw new Error("capture_dom_invalid");
    }
  }
  if (mediaType === "application/json" || mediaType.endsWith("+json")) {
    try {
      return { contentClass: "http_json", parsed: JSON.parse(body.toString("utf8")) as unknown };
    } catch {
      throw new Error("capture_json_invalid");
    }
  }
  if (
    mediaType.startsWith("text/") ||
    mediaType === "application/xml" ||
    mediaType.endsWith("+xml") ||
    mediaType === "application/x-www-form-urlencoded"
  ) {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(body);
    } catch {
      throw new Error("capture_text_invalid");
    }
    return { contentClass: "http_text" };
  }
  return { contentClass: "http_binary" };
}

function readPath(value: unknown, segments: readonly JsonPathSegment[]): unknown {
  let current = value;
  for (const segment of segments) {
    if (typeof segment === "number") {
      if (!Array.isArray(current) || segment >= current.length) return undefined;
      current = current[segment];
    } else {
      if (
        !current ||
        typeof current !== "object" ||
        Array.isArray(current) ||
        !Object.hasOwn(current, segment)
      )
        return undefined;
      current = (current as Record<string, unknown>)[segment];
    }
  }
  return current;
}

function asJsonScalar(value: unknown): JsonScalar | undefined {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return value;
  return undefined;
}

function pathIdentity(valuePath: readonly JsonPathSegment[]): string {
  return JSON.stringify(valuePath);
}

function protectedKeyForPath(valuePath: readonly JsonPathSegment[], usedKeys: Set<string>): string {
  const readable = valuePath
    .map((segment) => (typeof segment === "number" ? `item_${segment}` : segment))
    .join("_")
    .replace(/[^A-Za-z0-9_-]+/gu, "_")
    .replace(/^_+|_+$/gu, "");
  const base = `captured_${readable || "value"}`;
  const digestSuffix = sha256(pathIdentity(valuePath)).slice(0, 12);
  let candidate = base.length <= 128 ? base : `${base.slice(0, 115)}_${digestSuffix}`;
  if (usedKeys.has(candidate)) candidate = `${candidate.slice(0, 115)}_${digestSuffix}`;
  if (usedKeys.has(candidate)) throw new Error("capture_output_key_collision");
  usedKeys.add(candidate);
  return candidate;
}

function buildStructuralIndex(value: unknown): BrowserCaptureNode[] {
  const nodes: BrowserCaptureNode[] = [];
  const visit = (current: unknown, valuePath: JsonPathSegment[]): void => {
    if (current === null) {
      nodes.push({ path: valuePath, kind: "null", classification: "uncertain" });
      return;
    }
    if (Array.isArray(current)) {
      nodes.push({
        path: valuePath,
        kind: "array",
        classification: "uncertain",
        length: current.length,
      });
      current.forEach((child, index) => visit(child, [...valuePath, index]));
      return;
    }
    if (typeof current === "object") {
      const entries = Object.entries(current as Record<string, unknown>);
      nodes.push({
        path: valuePath,
        kind: "object",
        classification: "uncertain",
        length: entries.length,
      });
      for (const [childKey, child] of entries) visit(child, [...valuePath, childKey]);
      return;
    }
    if (typeof current === "string") {
      nodes.push({
        path: valuePath,
        kind: "string",
        classification: "uncertain",
        length: current.length,
      });
      return;
    }
    if (typeof current === "number" || typeof current === "boolean") {
      const kind = typeof current === "number" ? "number" : "boolean";
      nodes.push({ path: valuePath, kind, classification: "uncertain" });
    }
  };
  visit(value, []);
  return nodes;
}

function collectCandidates(value: unknown): ProtectionCandidate[] {
  const candidates: ProtectionCandidate[] = [];
  const descriptorKeys = new Set([
    "kind",
    "type",
    "name",
    "label",
    "semantic",
    "semanticHint",
    "format",
    "description",
  ]);
  const visit = (
    current: unknown,
    valuePath: JsonPathSegment[],
    inheritedHints: readonly string[] = [],
  ): void => {
    const scalar = asJsonScalar(current);
    if (scalar !== undefined) {
      candidates.push({
        path: valuePath,
        value: scalar,
        ...(inheritedHints.length > 0 ? { semanticHint: inheritedHints.join(" ") } : {}),
      });
      return;
    }
    if (Array.isArray(current)) {
      current.forEach((child, index) => visit(child, [...valuePath, index], inheritedHints));
      return;
    }
    if (current && typeof current === "object") {
      const entries = Object.entries(current as Record<string, unknown>);
      const localHints = entries.flatMap(([key, child]) =>
        descriptorKeys.has(key) && typeof child === "string" && child.length <= 200
          ? [`${key} ${child}`]
          : [],
      );
      const hints = [...inheritedHints, ...localHints].slice(-8);
      for (const [key, child] of entries) visit(child, [...valuePath, key], hints);
    }
  };
  visit(value, []);
  return candidates;
}

export class ProtectedCaptureVault {
  readonly #directory: string;
  readonly #runId: string;
  readonly #scopeId: string;
  readonly #authority: ProtectionAuthority;
  readonly #maxCaptureBytes: number;
  readonly #maxOperationBytes: number;
  readonly #retentionMs: number;
  readonly #encryptionKey: Buffer | undefined;
  readonly #legacyEncryptionKeys: readonly Buffer[];
  #captureKey: Buffer | null = null;
  #assetKey: Buffer | null = null;
  #legacyCaptureKeys: readonly Buffer[] = [];
  #legacyAssetKeys: readonly Buffer[] = [];
  #queue: Promise<void> = Promise.resolve();

  constructor(options: {
    directory: string;
    runId: string;
    scopeId: string;
    authority: ProtectionAuthority;
    maxCaptureBytes?: number;
    maxOperationBytes?: number;
    retentionMs?: number;
    /** A production key supplied by the runtime; local tests may use private files. */
    encryptionKey?: Buffer;
    /** Historical master keys accepted only when decrypting persisted captures. */
    legacyEncryptionKeys?: readonly Buffer[];
  }) {
    this.#directory = options.directory;
    this.#runId = options.runId;
    this.#scopeId = options.scopeId;
    this.#authority = options.authority;
    this.#maxCaptureBytes = options.maxCaptureBytes ?? DEFAULT_CAPTURE_LIMIT;
    this.#maxOperationBytes = options.maxOperationBytes ?? DEFAULT_OPERATION_LIMIT;
    this.#retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
    if (options.encryptionKey && options.encryptionKey.length !== 32)
      throw new Error("capture_master_key_invalid");
    if (options.legacyEncryptionKeys?.some((key) => key.length !== 32))
      throw new Error("capture_master_key_invalid");
    this.#encryptionKey = options.encryptionKey ? Buffer.from(options.encryptionKey) : undefined;
    this.#legacyEncryptionKeys = (options.legacyEncryptionKeys ?? []).map((key) =>
      Buffer.from(key),
    );
  }

  async initialize(): Promise<this> {
    await ensurePrivateDirectory(this.#directory);
    await ensurePrivateDirectory(path.join(this.#directory, "captures"));
    await ensurePrivateDirectory(path.join(this.#directory, "assets"));
    if (this.#encryptionKey) {
      const salt = Buffer.from(`${this.#runId}\0${this.#scopeId}`);
      this.#captureKey = Buffer.from(
        hkdfSync("sha256", this.#encryptionKey, salt, Buffer.from("capture-v2"), 32),
      );
      this.#assetKey = Buffer.from(
        hkdfSync("sha256", this.#encryptionKey, salt, Buffer.from("asset-v2"), 32),
      );
      this.#legacyCaptureKeys = this.#legacyEncryptionKeys.map((key) =>
        Buffer.from(hkdfSync("sha256", key, salt, Buffer.from("capture-v2"), 32)),
      );
      this.#legacyAssetKeys = this.#legacyEncryptionKeys.map((key) =>
        Buffer.from(hkdfSync("sha256", key, salt, Buffer.from("asset-v2"), 32)),
      );
    } else {
      this.#captureKey = await this.#loadOrCreateKey("capture.key");
      this.#assetKey = await this.#loadOrCreateKey("asset.key");
    }
    await this.deleteExpired();
    await this.#deleteOrphanAssets();
    return this;
  }

  beginProtection(effectId: string): ProtectionBarrierToken {
    return this.#authority.begin(effectId);
  }

  /** Restore every unresolved durable barrier before a replacement worker opens a page. */
  async resumeUnsettledProtection(): Promise<number> {
    const captureDirectory = path.join(this.#directory, "captures");
    const files = (await readdir(captureDirectory)).filter((name) =>
      name.endsWith(".receipt.json"),
    );
    let resumed = 0;
    for (const file of files) {
      const captureId = file.slice(0, -".receipt.json".length);
      const stored = await this.#readReceipt(captureId);
      if (stored.phase === "published") {
        if (!stored.publishedOutputs || !stored.stringLineageKeys)
          throw new Error("capture_published_protection_missing");
        const protectedValues = await this.#readPublishedValues(
          captureId,
          stored.publishedOutputs.protectedOutputs,
          new Set(stored.stringLineageKeys),
        );
        this.#authority.restoreProtectedValues(protectedValues);
        this.#authority.restorePublicValues(
          stored.publishedOutputs.decisions.flatMap((decision) => {
            const value = stored.publishedOutputs?.publicOutputs[decision.key];
            return decision.label === "public" && typeof value === "string"
              ? [{ value, allowedSinks: decision.allowedSinks }]
              : [];
          }),
        );
        resumed += 1;
        continue;
      }
      if (stored.phase === "discarded") {
        continue;
      }
      if (stored.phase !== "captured" && stored.phase !== "expired" && stored.phase !== "corrupt")
        continue;
      if (!stored.protectionBarrier) throw new Error("capture_protection_barrier_missing");
      this.#authority.resume(stored.protectionBarrier);
      resumed += 1;
    }
    return resumed;
  }

  async deleteExpired(now = new Date()): Promise<number> {
    const captureDirectory = path.join(this.#directory, "captures");
    const files = (await readdir(captureDirectory)).filter((name) =>
      name.endsWith(".receipt.json"),
    );
    let deleted = 0;
    for (const file of files) {
      const captureId = file.slice(0, -".receipt.json".length);
      const stored = await this.#readReceipt(captureId);
      if (stored.phase !== "captured" || new Date(stored.expiresAt).getTime() > now.getTime())
        continue;
      const expired: StoredReceipt = { ...stored, phase: "expired", structuralIndex: [] };
      await durableWrite(this.#receiptPath(captureId), JSON.stringify(expired));
      await unlink(this.#rawPath(captureId)).catch(() => undefined);
      deleted += 1;
    }
    return deleted;
  }

  async captureHttpResponse(input: HttpResponseCaptureInput): Promise<BrowserCaptureReceipt> {
    return this.#serial(async () => {
      if (input.body.length > this.#maxCaptureBytes) throw new Error("capture_capacity_exceeded");
      if (!Number.isInteger(input.status) || input.status < 100 || input.status > 599)
        throw new Error("capture_status_invalid");
      const url = new URL(input.url);
      const usedBytes = await this.#activeCaptureBytes();
      if (usedBytes + input.body.length > this.#maxOperationBytes)
        throw new Error("operation_capture_capacity_exceeded");
      const capturedAt = input.capturedAt ?? new Date();
      const captureId = randomUUID();
      const rawDigest = sha256(input.body);
      const classified = classifyHttpContent(input.contentType, input.body);
      const structuralIndex =
        classified.contentClass === "http_json" || classified.contentClass === "dom_region"
          ? buildStructuralIndex(classified.parsed)
          : classified.contentClass === "http_text"
            ? [
                {
                  path: ["$body"],
                  kind: "string" as const,
                  classification: "uncertain" as const,
                  length: new TextDecoder().decode(input.body).length,
                },
              ]
            : [];
      const receipt: StoredReceipt = {
        captureId,
        runId: this.#runId,
        effectId: input.effectId,
        phase: "captured",
        status: input.status,
        contentType:
          input.contentType.split(";")[0]?.trim().toLowerCase() || "application/octet-stream",
        contentClass: classified.contentClass,
        bodyBytes: input.body.length,
        redirectChain: input.redirectChain ?? [],
        capturedAt: capturedAt.toISOString(),
        expiresAt: new Date(capturedAt.getTime() + this.#retentionMs).toISOString(),
        structuralIndex,
        rawDigest,
        protectionBarrier: input.protectionBarrier,
      };
      const aad = {
        evidenceFormat: 1,
        runId: this.#runId,
        scopeId: this.#scopeId,
        effectId: input.effectId,
        captureId,
        method: input.method.toUpperCase(),
        origin: url.origin,
        contentClass: classified.contentClass,
        redirectChain: input.redirectChain ?? [],
        pathDigest: sha256(url.pathname),
        status: input.status,
        contentType: receipt.contentType,
      };
      await this.#encryptTo(this.#rawPath(captureId), input.body, this.#requiredCaptureKey(), aad);
      await durableWrite(this.#receiptPath(captureId), JSON.stringify(receipt));
      return browserCaptureReceiptSchema.parse(receipt);
    });
  }

  async exportDurableCapture(captureId: string): Promise<DurableCaptureEnvelope> {
    const stored = await this.#readReceipt(captureId);
    if (stored.phase !== "captured") throw new Error(`capture_not_exportable:${stored.phase}`);
    const encryptedPayload = await readFile(this.#rawPath(captureId));
    return {
      captureId,
      storedReceipt: structuredClone(stored) as unknown as Record<string, unknown>,
      encryptedPayload,
      encryptedPayloadDigest: sha256(encryptedPayload),
    };
  }

  /** Restore a database-authoritative capture before opening a replacement page. */
  async restoreDurableCapture(envelope: DurableCaptureEnvelope): Promise<void> {
    if (sha256(envelope.encryptedPayload) !== envelope.encryptedPayloadDigest)
      throw new Error("capture_envelope_digest_invalid");
    const stored = envelope.storedReceipt as unknown as StoredReceipt;
    if (
      stored.captureId !== envelope.captureId ||
      stored.runId !== this.#runId ||
      stored.phase !== "captured" ||
      !stored.protectionBarrier
    )
      throw new Error("capture_envelope_scope_invalid");
    try {
      const existing = await this.#readReceipt(envelope.captureId);
      if (existing.rawDigest !== stored.rawDigest || existing.effectId !== stored.effectId)
        throw new Error("capture_envelope_conflict");
      return;
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "capture_unknown") throw error;
    }
    await durableWrite(this.#rawPath(envelope.captureId), envelope.encryptedPayload);
    await durableWrite(this.#receiptPath(envelope.captureId), JSON.stringify(stored));
    const plaintext = await this.#decryptRaw(envelope.captureId);
    try {
      if (sha256(plaintext) !== stored.rawDigest)
        throw new Error("capture_plaintext_digest_invalid");
    } finally {
      plaintext.fill(0);
    }
  }

  async receipt(captureId: string, now = new Date()): Promise<BrowserCaptureReceipt> {
    const stored = await this.#readReceipt(captureId);
    if (stored.phase === "captured" && new Date(stored.expiresAt).getTime() <= now.getTime()) {
      const expired: StoredReceipt = { ...stored, phase: "expired", structuralIndex: [] };
      await durableWrite(this.#receiptPath(captureId), JSON.stringify(expired));
      await unlink(this.#rawPath(captureId)).catch(() => undefined);
      return browserCaptureReceiptSchema.parse(expired);
    }
    return browserCaptureReceiptSchema.parse(stored);
  }

  async publish(
    captureId: string,
    rawSelections: readonly BrowserOutputSelection[],
    options: { deferReleaseUntilDurablePublication?: boolean } = {},
  ): Promise<BrowserPublishedOutputs> {
    return this.#serial(async () => {
      const stored = await this.#readReceipt(captureId);
      if (stored.contentClass !== "http_json" && stored.contentClass !== "dom_region")
        throw new Error(`capture_output_mapping_unsupported:${stored.contentClass}`);
      const publishableContentClass = stored.contentClass;
      const requestedSelections = rawSelections.map((selection) =>
        browserOutputSelectionSchema.parse(selection),
      );
      if (requestedSelections.length === 0) throw new Error("capture_output_selection_required");
      const uniqueKeys = new Set(requestedSelections.map((selection) => selection.key));
      if (uniqueKeys.size !== requestedSelections.length)
        throw new Error("capture_output_key_duplicate");
      const selectedPaths = new Set(
        requestedSelections.map((selection) => pathIdentity(selection.path)),
      );
      const selections = requestedSelections;
      if (selections.length > MAX_PUBLISHED_OUTPUTS)
        throw new Error("capture_output_limit_exceeded");
      const selectionDigest = sha256(JSON.stringify(selections));
      if (stored.phase === "published") {
        if (stored.selectionDigest !== selectionDigest || !stored.publishedOutputs)
          throw new Error("capture_publication_conflict");
        if (options.deferReleaseUntilDurablePublication && stored.publicationBarrier)
          this.#authority.resume(stored.publicationBarrier);
        await unlink(this.#rawPath(captureId)).catch((error) => {
          if (!isNodeError(error) || error.code !== "ENOENT") throw error;
        });
        return browserPublishedOutputsSchema.parse(stored.publishedOutputs);
      }
      const current = await this.receipt(captureId);
      if (current.phase === "expired") throw new Error("capture_expired");
      if (current.phase !== "captured") throw new Error(`capture_not_publishable:${current.phase}`);
      let plaintext: Buffer;
      try {
        plaintext = await this.#decryptRaw(captureId);
      } catch (error) {
        const corrupt: StoredReceipt = { ...stored, phase: "corrupt", structuralIndex: [] };
        await durableWrite(this.#receiptPath(captureId), JSON.stringify(corrupt));
        throw error;
      }
      try {
        if (sha256(plaintext) !== stored.rawDigest)
          throw new Error("capture_plaintext_digest_invalid");
        const parsed = JSON.parse(plaintext.toString("utf8")) as unknown;
        const candidates = collectCandidates(parsed);
        const candidateByPath = new Map(
          candidates.map((candidate) => [pathIdentity(candidate.path), candidate] as const),
        );
        const candidatePaths = new Set(candidates.map((candidate) => pathIdentity(candidate.path)));
        if (selections.some((selection) => !candidatePaths.has(pathIdentity(selection.path))))
          throw new Error("capture_output_mapping_incomplete");
        this.#authority.resume(stored.protectionBarrier);
        const proposals: ProtectionProposal[] = selections.map((selection) => ({
          ...selection,
          ...(selection.classification === "public"
            ? {
                evidence: this.#authority.publicEvidence(
                  stored.protectionBarrier,
                  selection.semantic,
                  selection.path,
                  {
                    id: captureId,
                    digest: stored.rawDigest,
                    observedAt: stored.capturedAt,
                    contentClass: publishableContentClass,
                  },
                ),
              }
            : {}),
        }));
        const decisions = this.#authority.settle({
          token: stored.protectionBarrier,
          captureId,
          candidates,
          proposals,
        });
        const decisionByPath = new Map(
          decisions.map((decision) => [pathIdentity(decision.path), decision] as const),
        );
        const publicOutputs: Record<string, JsonScalar> = {};
        const protectedOutputs: Record<string, { reference: string; digest: string }> = {};
        const preparedAssets: Array<{ key: string; reference: string; value: string }> = [];
        for (const selection of selections) {
          const value = asJsonScalar(readPath(parsed, selection.path));
          if (value === undefined) throw new Error("capture_output_mapping_incomplete");
          const stringValue = value === null ? "null" : String(value);
          const decision = decisionByPath.get(pathIdentity(selection.path));
          if (!decision) throw new Error("capture_protection_decision_missing");
          if (decision.label === "public") {
            this.#authority.emit(value, decision, "database_safe_field");
            publicOutputs[selection.key] = this.#authority.emit(
              value,
              decision,
              "mcp_response",
            ) as JsonScalar;
          } else {
            preparedAssets.push({
              key: selection.key,
              reference: randomUUID(),
              value: stringValue,
            });
          }
        }
        for (const decision of decisions) {
          if (decision.label !== "protected" || selectedPaths.has(pathIdentity(decision.path)))
            continue;
          const value = asJsonScalar(readPath(parsed, decision.path));
          if (value === undefined) throw new Error("capture_output_mapping_incomplete");
          preparedAssets.push({
            key: decision.key,
            reference: randomUUID(),
            value: value === null ? "null" : String(value),
          });
        }
        for (const asset of preparedAssets) {
          await this.#encryptTo(
            this.#assetPath(asset.reference),
            Buffer.from(asset.value),
            this.#requiredAssetKey(),
            {
              evidenceFormat: 1,
              runId: this.#runId,
              scopeId: this.#scopeId,
              captureId,
              reference: asset.reference,
              outputKey: asset.key,
            },
          );
          protectedOutputs[asset.key] = { reference: asset.reference, digest: sha256(asset.value) };
        }
        const published = browserPublishedOutputsSchema.parse({
          captureId,
          publicOutputs,
          protectedOutputs,
          decisions,
        });
        const publicationBarrier = options.deferReleaseUntilDurablePublication
          ? this.#authority.begin(stored.effectId)
          : undefined;
        const publishedReceipt: StoredReceipt = {
          ...stored,
          phase: "published",
          structuralIndex: [],
          selectionDigest,
          publishedOutputs: published,
          stringLineageKeys: decisions.flatMap((decision) => {
            const candidate = candidateByPath.get(pathIdentity(decision.path));
            return decision.label === "protected" && typeof candidate?.value === "string"
              ? [decision.key]
              : [];
          }),
          ...(publicationBarrier ? { publicationBarrier } : {}),
        };
        try {
          await durableWrite(this.#receiptPath(captureId), JSON.stringify(publishedReceipt));
        } catch (error) {
          if (publicationBarrier) {
            this.#authority.abort(publicationBarrier);
            this.#authority.resume(stored.protectionBarrier);
          }
          throw error;
        }
        await unlink(this.#rawPath(captureId));
        return published;
      } finally {
        plaintext.fill(0);
      }
    });
  }

  async releasePublishedBarrier(captureId: string): Promise<void> {
    const stored = await this.#readReceipt(captureId);
    if (stored.phase !== "published") throw new Error("capture_publication_not_ready");
    if (!stored.publicationBarrier) return;
    this.#authority.abort(stored.publicationBarrier);
    const { publicationBarrier: _released, ...released } = stored;
    await durableWrite(this.#receiptPath(captureId), JSON.stringify(released));
  }

  async discard(captureId: string): Promise<DiscardedCaptureProtection> {
    return this.#serial(async () => {
      const stored = await this.#readReceipt(captureId);
      if (stored.phase === "discarded") {
        return { receipt: browserCaptureReceiptSchema.parse(stored) };
      }
      if (stored.phase !== "captured") throw new Error(`capture_not_discardable:${stored.phase}`);
      this.#authority.resume(stored.protectionBarrier);
      this.#authority.settle({
        token: stored.protectionBarrier,
        captureId,
        candidates: [],
        proposals: [],
      });
      const discarded: StoredReceipt = { ...stored, phase: "discarded", structuralIndex: [] };
      await durableWrite(this.#receiptPath(captureId), JSON.stringify(discarded));
      await unlink(this.#rawPath(captureId));
      return { receipt: browserCaptureReceiptSchema.parse(discarded) };
    });
  }

  async deliverProtectedToBrowser(
    reference: string,
    sink: ProtectedBrowserSink,
  ): Promise<{ reference: string; digest: string }> {
    const record = await this.#readEncrypted(this.#assetPath(reference));
    if (
      record.aad.runId !== this.#runId ||
      record.aad.scopeId !== this.#scopeId ||
      record.aad.reference !== reference
    ) {
      throw new Error("protected_asset_scope_mismatch");
    }
    const plaintext = await this.#decrypt(record, this.#requiredAssetKey(), this.#legacyAssetKeys);
    try {
      await sink.fill(plaintext.toString("utf8"));
      return { reference, digest: sha256(plaintext) };
    } finally {
      plaintext.fill(0);
    }
  }

  async #activeCaptureBytes(): Promise<number> {
    const files = (await readdir(path.join(this.#directory, "captures"))).filter((name) =>
      name.endsWith(".receipt.json"),
    );
    let total = 0;
    for (const file of files) {
      const receipt = JSON.parse(
        await readFile(path.join(this.#directory, "captures", file), "utf8"),
      ) as StoredReceipt;
      if (receipt.phase === "captured" && new Date(receipt.expiresAt).getTime() > Date.now())
        total += receipt.bodyBytes;
    }
    return total;
  }

  async #deleteOrphanAssets(): Promise<void> {
    const captureFiles = (await readdir(path.join(this.#directory, "captures"))).filter((name) =>
      name.endsWith(".receipt.json"),
    );
    const referenced = new Set<string>();
    for (const file of captureFiles) {
      const stored = JSON.parse(
        await readFile(path.join(this.#directory, "captures", file), "utf8"),
      ) as StoredReceipt;
      for (const output of Object.values(stored.publishedOutputs?.protectedOutputs ?? {}))
        referenced.add(output.reference);
    }
    for (const file of await readdir(path.join(this.#directory, "assets"))) {
      if (!file.endsWith(".json")) continue;
      const reference = file.slice(0, -".json".length);
      if (!referenced.has(reference)) await unlink(path.join(this.#directory, "assets", file));
    }
  }

  async #readReceipt(captureId: string): Promise<StoredReceipt> {
    try {
      return JSON.parse(await readFile(this.#receiptPath(captureId), "utf8")) as StoredReceipt;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") throw new Error("capture_unknown");
      throw new Error("capture_receipt_invalid");
    }
  }

  async #loadOrCreateKey(name: string): Promise<Buffer> {
    const target = path.join(this.#directory, name);
    try {
      const key = Buffer.from(await readFile(target, "utf8"), "base64");
      if (key.length !== 32) throw new Error("capture_key_invalid");
      return key;
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
      const key = randomBytes(32);
      await durableWrite(target, key.toString("base64"));
      return key;
    }
  }

  async #encryptTo(
    target: string,
    plaintext: Buffer,
    key: Buffer,
    aadObject: Record<string, unknown>,
  ): Promise<void> {
    const nonce = randomBytes(12);
    const aad = Buffer.from(JSON.stringify(aadObject));
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    const record: EncryptedRecord = {
      aad: aadObject,
      nonce: nonce.toString("base64"),
      ciphertext: ciphertext.toString("base64"),
      tag: tag.toString("base64"),
      digest: sha256(Buffer.concat([aad, nonce, ciphertext, tag])),
    };
    await durableWrite(target, JSON.stringify(record));
  }

  async #decryptRaw(captureId: string): Promise<Buffer> {
    const record = await this.#readEncrypted(this.#rawPath(captureId));
    if (
      record.aad.runId !== this.#runId ||
      record.aad.scopeId !== this.#scopeId ||
      record.aad.captureId !== captureId
    ) {
      throw new Error("capture_scope_mismatch");
    }
    return this.#decrypt(record, this.#requiredCaptureKey(), this.#legacyCaptureKeys);
  }

  async #readEncrypted(target: string): Promise<EncryptedRecord> {
    try {
      return JSON.parse(await readFile(target, "utf8")) as EncryptedRecord;
    } catch {
      throw new Error("encrypted_record_invalid");
    }
  }

  async #readPublishedValues(
    captureId: string,
    outputs: BrowserPublishedOutputs["protectedOutputs"],
    allowedKeys: ReadonlySet<string>,
  ): Promise<Record<string, string>> {
    const values: Record<string, string> = {};
    for (const [key, output] of Object.entries(outputs)) {
      if (!allowedKeys.has(key)) continue;
      const record = await this.#readEncrypted(this.#assetPath(output.reference));
      if (
        record.aad.runId !== this.#runId ||
        record.aad.scopeId !== this.#scopeId ||
        record.aad.captureId !== captureId ||
        record.aad.reference !== output.reference ||
        record.aad.outputKey !== key
      )
        throw new Error("published_protection_scope_mismatch");
      const plaintext = await this.#decrypt(
        record,
        this.#requiredAssetKey(),
        this.#legacyAssetKeys,
      );
      try {
        if (sha256(plaintext) !== output.digest)
          throw new Error("published_protection_digest_invalid");
        values[key] = plaintext.toString("utf8");
      } finally {
        plaintext.fill(0);
      }
    }
    return values;
  }

  async #decrypt(
    record: EncryptedRecord,
    key: Buffer,
    legacyKeys: readonly Buffer[],
  ): Promise<Buffer> {
    const aad = Buffer.from(JSON.stringify(record.aad));
    const nonce = Buffer.from(record.nonce, "base64");
    const ciphertext = Buffer.from(record.ciphertext, "base64");
    const tag = Buffer.from(record.tag, "base64");
    if (sha256(Buffer.concat([aad, nonce, ciphertext, tag])) !== record.digest)
      throw new Error("encrypted_record_digest_invalid");
    for (const candidate of [key, ...legacyKeys]) {
      try {
        const decipher = createDecipheriv("aes-256-gcm", candidate, nonce);
        decipher.setAAD(aad);
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      } catch {
        // Historical keys are read-only compatibility candidates.
      }
    }
    throw new Error("encrypted_record_authentication_invalid");
  }

  #requiredCaptureKey(): Buffer {
    if (!this.#captureKey) throw new Error("capture_vault_not_initialized");
    return this.#captureKey;
  }

  #requiredAssetKey(): Buffer {
    if (!this.#assetKey) throw new Error("capture_vault_not_initialized");
    return this.#assetKey;
  }

  #receiptPath(captureId: string): string {
    return path.join(this.#directory, "captures", `${captureId}.receipt.json`);
  }

  #rawPath(captureId: string): string {
    return path.join(this.#directory, "captures", `${captureId}.raw.json`);
  }

  #assetPath(reference: string): string {
    return path.join(this.#directory, "assets", `${reference}.json`);
  }

  async #serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(operation, operation);
    this.#queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
