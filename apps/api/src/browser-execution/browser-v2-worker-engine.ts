import { createHash, randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Browser, BrowserContext, ElementHandle, Page, Request } from "playwright";
import { chromium } from "playwright";
import type {
  BrowserCaptureReceipt,
  BrowserCommandV2,
  BrowserOutputSelection,
} from "@scry/contracts";
import {
  AuthenticatedEvidenceStore,
  ProtectedCaptureVault,
  ProtectionAuthority,
  SanitizedBrowserRecorder,
  renderSanitizedReplay,
} from "@scry/browser-runtime";

import { BrowserCommandRepository } from "./repositories/browser-command.repository.js";
import { BrowserExecutionRepository } from "./repositories/browser-execution.repository.js";
import { BrowserProtectedKeyring } from "./browser-protected-keyring.js";

interface ActiveSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  ownerGeneration: number;
  documentEpoch: number;
  runId: string;
  sessionId: string;
  baseOrigin: string;
  root: string;
  references: Map<string, { epoch: number; handle: ElementHandle<HTMLElement> }>;
  authority: ProtectionAuthority;
  evidence: AuthenticatedEvidenceStore<Record<string, unknown>>;
  recorder: SanitizedBrowserRecorder;
  vault: ProtectedCaptureVault;
  ownerLeaseToken: string;
  ownerHeartbeat: NodeJS.Timeout;
}

const digest = (value: unknown) =>
  createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");

function derivedSessionKey(
  keyVersion: string,
  purpose: "evidence" | "capture",
  runId: string,
  sessionId: string,
): Buffer {
  return BrowserProtectedKeyring.fromEnvironment().derive(
    keyVersion,
    purpose,
    `${runId}:${sessionId}`,
  );
}

function safeRedirectChain(
  status: number,
  location: string | undefined,
  requestUrl: string,
  baseOrigin: string,
): Array<{ status: number; sameOrigin: boolean; targetDigest: string }> {
  if (status < 300 || status > 399 || !location) return [];
  let target: URL;
  try {
    target = new URL(location, requestUrl);
  } catch {
    return [];
  }
  return [
    {
      status,
      sameOrigin: target.origin === new URL(baseOrigin).origin,
      targetDigest: digest(target.href),
    },
  ];
}

export class BrowserV2WorkerEngine {
  readonly #sessions = new Map<string, ActiveSession>();
  readonly #opening = new Map<string, Promise<{ sessionId: string; ownerGeneration: number }>>();
  constructor(
    private readonly commands: BrowserCommandRepository,
    private readonly effects: BrowserExecutionRepository,
  ) {}

  async open(sessionId: string): Promise<{ sessionId: string; ownerGeneration: number }> {
    await this.effects.assertCompatibleBaseline();
    const existing = this.#sessions.get(sessionId);
    if (existing) return { sessionId, ownerGeneration: existing.ownerGeneration };
    const opening = this.#opening.get(sessionId);
    if (opening) return opening;
    const operation = this.#openNew(sessionId);
    this.#opening.set(sessionId, operation);
    try {
      return await operation;
    } finally {
      this.#opening.delete(sessionId);
    }
  }

  async #openNew(sessionId: string): Promise<{ sessionId: string; ownerGeneration: number }> {
    const scope = await this.commands.sessionContext(sessionId);
    const ownerLeaseMs = 60_000;
    const owner = await this.effects.claimOwner(
      sessionId,
      `browser-v2-worker:${process.pid}`,
      ownerLeaseMs,
    );
    const root = path.resolve(
      process.env.BROWSER_V2_ARTIFACT_ROOT ?? "artifacts/browser-v2",
      sessionId,
    );
    const evidence = await new AuthenticatedEvidenceStore<Record<string, unknown>>({
      directory: path.join(root, "evidence"),
      runId: scope.runId,
      scopeId: sessionId,
      encryptionKey: derivedSessionKey(
        scope.protectionKeyVersion,
        "evidence",
        scope.runId,
        sessionId,
      ),
      maxSessionBytes: 20 * 1024 * 1024,
    }).initialize();
    const [protectedValues, restoredPublicValues] = await Promise.all([
      this.commands.protectedValuesForSession(sessionId),
      this.commands.publicValuesForSession(sessionId),
    ]);
    const authority = new ProtectionAuthority({
      scope: {
        projectId: scope.projectId,
        missionId: scope.missionId,
        runId: scope.runId,
        sessionId,
        origin: new URL(scope.baseOrigin).origin,
      },
      disclosureMode: scope.disclosureMode,
      protectedValues,
      restoredPublicValues,
    });
    const captureCache = path.join(root, "captures");
    // PostgreSQL is authoritative. Never let files left by a dead worker
    // resurrect a capture that the database already settled or deleted.
    await rm(captureCache, { recursive: true, force: true });
    const vault = await new ProtectedCaptureVault({
      directory: captureCache,
      runId: scope.runId,
      scopeId: sessionId,
      authority,
      encryptionKey: derivedSessionKey(
        scope.protectionKeyVersion,
        "capture",
        scope.runId,
        sessionId,
      ),
    }).initialize();
    for (const capture of await this.effects.durableCapturesForSession(sessionId))
      await vault.restoreDurableCapture(capture);
    await vault.resumeUnsettledProtection();
    let browser: Browser | undefined;
    let context: BrowserContext | undefined;
    let ownerHeartbeat: NodeJS.Timeout | undefined;
    try {
      const checkpoint = await this.commands.loadBrowserCheckpoint(sessionId, owner.generation);
      browser = await chromium.launch({
        headless: process.env.BROWSER_V2_HEADLESS !== "false",
        channel: process.env.SCRY_BROWSER_CHANNEL ?? "chrome",
      });
      context = await browser.newContext({
        ...(checkpoint ? { storageState: checkpoint.storageState } : {}),
      });
      if (checkpoint && Object.keys(checkpoint.sessionStorage).length > 0) {
        await context.addInitScript(
          ({ origin, values }) => {
            if (window.location.origin !== origin) return;
            for (const [key, value] of Object.entries(values))
              window.sessionStorage.setItem(key, value);
          },
          { origin: new URL(scope.baseOrigin).origin, values: checkpoint.sessionStorage },
        );
      }
      const page = await context.newPage();
      const recorder = new SanitizedBrowserRecorder({ store: evidence, authority });
      await recorder.start(context);
      ownerHeartbeat = setInterval(
        () =>
          void this.effects
            .heartbeatOwner(sessionId, owner.generation, owner.leaseToken, ownerLeaseMs)
            .catch(() => undefined),
        20_000,
      );
      const session: ActiveSession = {
        browser,
        context,
        page,
        ownerGeneration: owner.generation,
        documentEpoch: 0,
        runId: scope.runId,
        sessionId,
        baseOrigin: scope.baseOrigin,
        root,
        references: new Map(),
        authority,
        evidence,
        recorder,
        vault,
        ownerLeaseToken: owner.leaseToken,
        ownerHeartbeat,
      };
      page.on("framenavigated", (frame) => {
        if (frame === page.mainFrame()) {
          session.documentEpoch += 1;
          session.references.clear();
        }
      });
      if (checkpoint) {
        this.assertOrigin(session, checkpoint.resumeUrl);
        await page.goto(checkpoint.resumeUrl);
      }
      this.#sessions.set(sessionId, session);
      return { sessionId, ownerGeneration: owner.generation };
    } catch (error) {
      if (ownerHeartbeat) clearInterval(ownerHeartbeat);
      await context?.close().catch(() => undefined);
      await browser?.close().catch(() => undefined);
      await this.effects
        .releaseOwner(sessionId, owner.generation, owner.leaseToken)
        .catch(() => undefined);
      throw error;
    }
  }

  async execute(sessionId: string, command: BrowserCommandV2): Promise<Record<string, unknown>> {
    const session = await this.requiredSession(sessionId);
    const result = await this.executeInSession(session, command);
    if (command.kind !== "close" && command.kind !== "close_for_failure")
      await this.persistCheckpoint(session);
    return result;
  }

  private async executeInSession(
    session: ActiveSession,
    command: BrowserCommandV2,
  ): Promise<Record<string, unknown>> {
    switch (command.kind) {
      case "navigate": {
        this.assertOrigin(session, command.url);
        await session.page.goto(command.url);
        return this.observe(session);
      }
      case "observe":
        return this.observe(session);
      case "fill": {
        const handle = this.handle(session, command.reference);
        if (command.protectedValueId) {
          let value = await this.commands.protectedValueForBrowser(
            session.sessionId,
            command.protectedValueId,
          );
          try {
            await handle.fill(value);
          } finally {
            value = "";
          }
        } else await handle.fill(command.publicValue ?? "");
        return { documentEpoch: session.documentEpoch, filled: true };
      }
      case "click":
        await this.readOnlyInteraction(session, () =>
          this.handle(session, command.reference).click(),
        );
        return this.observe(session);
      case "press":
        await this.readOnlyInteraction(session, () =>
          this.handle(session, command.reference).press(command.key),
        );
        return this.observe(session);
      case "capture_dom":
        return this.captureDom(session, command.effectId, command.reference);
      case "commit":
        return this.commit(session, command);
      case "publish_capture":
        return this.publish(session, command.effectId, command.captureId, command.selections);
      case "discard_capture":
        return this.discard(session, command.effectId, command.captureId);
      case "determine":
        return (await this.effects.determine(
          command.effectId,
          session.ownerGeneration,
          command.outcome,
          command.source,
        )) as unknown as Record<string, unknown>;
      case "close":
        await this.close(session.sessionId);
        return { closed: true };
      case "close_for_failure":
        await this.closeForFailure(session.sessionId);
        return { closed: true, unresolvedEffectsPreserved: true };
    }
  }

  async close(sessionId: string): Promise<void> {
    return this.closeSession(sessionId, false);
  }

  async closeForFailure(sessionId: string): Promise<void> {
    return this.closeSession(sessionId, true);
  }

  private async closeSession(sessionId: string, forFailure: boolean): Promise<void> {
    const session = this.#sessions.get(sessionId);
    if (!session) return;
    if (forFailure)
      await this.effects.prepareFailureFinalization(sessionId, session.ownerGeneration);
    else await this.effects.assertNoPendingEffectOutcomes(sessionId);
    const unsettled = await this.effects.unsettledCaptureIds(sessionId);
    if (unsettled.length > 0)
      throw new Error(`BROWSER_V2_CAPTURES_UNSETTLED:${unsettled.join(",")}`);
    this.#sessions.delete(sessionId);
    clearInterval(session.ownerHeartbeat);
    const diagnostics = await session.recorder.flush();
    if (diagnostics.errors.length)
      throw new Error(`BROWSER_V2_RECORDER_FAILED:${diagnostics.errors[0]?.code ?? "unknown"}`);
    await session.recorder.close();
    await session.context.close();
    await session.browser.close();
    const verified = await session.evidence.verify();
    if (!verified.complete || !verified.lastDigest || verified.chunks === 0)
      throw new Error("BROWSER_V2_EVIDENCE_INCOMPLETE");
    let videoObjectKey: string | undefined;
    if (process.env.BROWSER_V2_RENDER_VIDEO === "true") {
      const ledgerPath = path.join(session.root, "actions.jsonl");
      const ledger = await this.commands.safeActionLedger(sessionId);
      await writeFile(ledgerPath, `${ledger.map((entry) => JSON.stringify(entry)).join("\n")}\n`, {
        mode: 0o600,
      });
      const publication = await renderSanitizedReplay({
        events: verified.events,
        ledgerPath,
        outputDirectory: path.join(session.root, "rendered"),
        ...(process.env.BROWSER_V2_CHROME_PATH
          ? { executablePath: process.env.BROWSER_V2_CHROME_PATH }
          : {}),
      });
      videoObjectKey = `local://${publication.videoPath}`;
    }
    await this.commands.completeEvidence({
      sessionId,
      runId: session.runId,
      chainHead: verified.lastDigest,
      chunkCount: verified.chunks,
      totalBytes: verified.storedBytes,
      replayObjectKey: `local://${path.join(session.root, "evidence")}`,
      ...(videoObjectKey ? { videoObjectKey } : {}),
    });
    await this.commands.deleteBrowserCheckpoint(sessionId, session.ownerGeneration);
  }

  async closeAll(): Promise<void> {
    for (const sessionId of [...this.#sessions.keys()])
      await this.close(sessionId).catch(() => undefined);
  }

  private async requiredSession(sessionId: string): Promise<ActiveSession> {
    await this.open(sessionId);
    return this.#sessions.get(sessionId)!;
  }

  private async observe(session: ActiveSession): Promise<Record<string, unknown>> {
    session.references.clear();
    const controls: Array<Record<string, unknown>> = [];
    const locator = session.page.locator(
      "a,button,input,textarea,select,[role=button],[role=link]",
    );
    const count = Math.min(await locator.count(), 200);
    for (let index = 0; index < count; index += 1) {
      const handle = (await locator
        .nth(index)
        .elementHandle()) as ElementHandle<HTMLElement> | null;
      if (!handle) continue;
      const facts = await handle.evaluate((element) => ({
        tag: element.tagName.toLowerCase(),
        type: element.getAttribute("type"),
        role: element.getAttribute("role"),
        name:
          element.getAttribute("aria-label") ??
          element.getAttribute("placeholder") ??
          element.textContent?.trim().slice(0, 200) ??
          "",
      }));
      const reference = randomUUID();
      session.references.set(reference, { epoch: session.documentEpoch, handle });
      controls.push({
        reference,
        tag: facts.tag,
        type: facts.type,
        role: facts.role,
        name: session.authority.sanitize(facts.name, "agent_observation"),
      });
    }
    const regions: Array<Record<string, unknown>> = [];
    const regionLocator = session.page.locator(
      "dialog,[role=dialog],[aria-live=polite],[aria-live=assertive],main,section,article",
    );
    const regionCount = Math.min(await regionLocator.count(), 100);
    for (let index = 0; index < regionCount; index += 1) {
      const handle = (await regionLocator
        .nth(index)
        .elementHandle()) as ElementHandle<HTMLElement> | null;
      if (!handle) continue;
      const facts = await handle.evaluate((element) => ({
        tag: element.tagName.toLowerCase(),
        role: element.getAttribute("role"),
        name: element.getAttribute("aria-label") ?? element.getAttribute("aria-labelledby") ?? "",
        text: element.textContent?.trim().slice(0, 500) ?? "",
      }));
      const reference = randomUUID();
      session.references.set(reference, { epoch: session.documentEpoch, handle });
      regions.push({
        reference,
        tag: facts.tag,
        role: facts.role,
        name: session.authority.sanitize(facts.name, "agent_observation"),
        text: session.authority.sanitize(facts.text, "agent_observation"),
      });
    }
    const bodyText = session.authority.sanitize(
      (
        await session.page
          .locator("body")
          .innerText()
          .catch(() => "")
      ).slice(0, 20_000),
      "agent_observation",
    );
    return {
      url: session.authority.sanitize(session.page.url(), "agent_observation"),
      title: await session.page.title(),
      documentEpoch: session.documentEpoch,
      controls,
      regions,
      text: bodyText,
      truncated: bodyText.length >= 20_000,
    };
  }

  private handle(session: ActiveSession, reference: string): ElementHandle<HTMLElement> {
    const target = session.references.get(reference);
    if (!target || target.epoch !== session.documentEpoch)
      throw new Error("BROWSER_V2_REFERENCE_STALE");
    return target.handle;
  }

  private assertOrigin(session: ActiveSession, url: string): void {
    if (new URL(url).origin !== new URL(session.baseOrigin).origin)
      throw new Error("BROWSER_V2_ORIGIN_NOT_ALLOWED");
  }

  private async persistCheckpoint(session: ActiveSession): Promise<void> {
    const resumeUrl = session.page.url();
    if (resumeUrl === "about:blank") return;
    this.assertOrigin(session, resumeUrl);
    const storageState = await session.context.storageState({ indexedDB: true });
    const sessionStorage = await session.page.evaluate(() =>
      Object.fromEntries(
        Array.from({ length: window.sessionStorage.length }, (_, index) => {
          const key = window.sessionStorage.key(index) ?? "";
          return [key, window.sessionStorage.getItem(key) ?? ""] as const;
        }).filter(([key]) => key.length > 0),
      ),
    );
    await this.commands.saveBrowserCheckpoint(session.sessionId, session.ownerGeneration, {
      resumeUrl,
      storageState,
      sessionStorage,
    });
  }

  private async commit(
    session: ActiveSession,
    command: Extract<BrowserCommandV2, { kind: "commit" }>,
  ): Promise<Record<string, unknown>> {
    const existing = await this.effects.recoverAdmittedEffect({
      sessionId: session.sessionId,
      idempotencyKey: command.effectIdempotencyKey,
      effectClass: command.effectClass,
      expectedOrigin: new URL(session.baseOrigin).origin,
      intentSummary: command.intentSummary,
    });
    if (existing)
      return {
        effectId: existing.effectId,
        replay: true,
        ...(await this.effects.recoverEffect(existing.effectId)),
      };
    const target = this.handle(session, command.reference);
    const targetFacts = await target.evaluate((element) => ({
      tag: element.tagName.toLowerCase(),
      type: element.getAttribute("type") ?? "",
      role: element.getAttribute("role") ?? "",
      name: element.getAttribute("aria-label") ?? element.textContent?.trim().slice(0, 200) ?? "",
    }));
    const targetDigest = digest({
      ...targetFacts,
      name: session.authority.sanitize(targetFacts.name, "database_safe_field"),
    });
    const actionDigest = digest({
      kind: command.kind,
      effectClass: command.effectClass,
      intentSummary: command.intentSummary,
      path: new URL(session.page.url()).pathname,
      targetDigest,
    });
    const effect = await this.effects.admitEffect({
      sessionId: session.sessionId,
      ownerGeneration: session.ownerGeneration,
      documentEpoch: session.documentEpoch,
      idempotencyKey: command.effectIdempotencyKey,
      effectClass: command.effectClass,
      expectedOrigin: new URL(session.baseOrigin).origin,
      targetDigest,
      actionDigest,
      intentSummary: command.intentSummary,
    });
    if (!effect.replay && effect.effect.dispatch_state === "not_started") {
      const protectionBarrier = session.authority.begin(effect.effect.id);
      let writeCount = 0;
      let blockedWrite = false;
      let dispatchBegan = false;
      let captureDurable = false;
      type OwnedResult = { receipt: BrowserCaptureReceipt } | { error: Error };
      let settleOwned!: (result: OwnedResult) => void;
      const ownedResult = new Promise<OwnedResult>((resolve) => {
        settleOwned = resolve;
      });
      const gate = async (route: import("playwright").Route) => {
        const request = route.request();
        const method = request.method();
        const sameOrigin = new URL(request.url()).origin === new URL(session.baseOrigin).origin;
        if (!sameOrigin) {
          if (!["GET", "HEAD", "OPTIONS"].includes(method)) blockedWrite = true;
          return route.abort("blockedbyclient");
        }
        if (["GET", "HEAD", "OPTIONS"].includes(method)) return route.continue();
        if (sameOrigin && writeCount === 0) {
          writeCount += 1;
          try {
            await this.effects.markDispatchStarted(effect.effect.id, session.ownerGeneration);
            dispatchBegan = true;
            const fetched = await bounded(
              route.fetch({ timeout: command.timeoutMs, maxRedirects: 0 }),
              command.timeoutMs,
              "BROWSER_V2_PROVIDER_RESPONSE_TIMEOUT",
            );
            const body = Buffer.from(
              await bounded(fetched.body(), command.timeoutMs, "BROWSER_V2_RESPONSE_BODY_TIMEOUT"),
            );
            const headers = fetched.headers();
            const redirectChain = safeRedirectChain(
              fetched.status(),
              headers.location,
              request.url(),
              session.baseOrigin,
            );
            const receipt = await session.vault.captureHttpResponse({
              effectId: effect.effect.id,
              method,
              url: request.url(),
              status: fetched.status(),
              contentType: headers["content-type"] ?? "application/octet-stream",
              body,
              redirectChain,
              protectionBarrier,
            });
            const durable = await session.vault.exportDurableCapture(receipt.captureId);
            await this.effects.registerCapture({
              effectId: effect.effect.id,
              ownerGeneration: session.ownerGeneration,
              captureId: receipt.captureId,
              evidenceVersion: 1,
              objectKey: `postgres://browser_captures/${receipt.captureId}`,
              ciphertextDigest: durable.encryptedPayloadDigest,
              authenticatedMetadata: {
                receiptDigest: digest(receipt),
                protectionScopeDigest: protectionBarrier.scopeDigest,
                protectionDecisionRevision: protectionBarrier.decisionRevision,
                storedReceipt: durable.storedReceipt,
              },
              contentClass: receipt.contentClass,
              byteSize: receipt.bodyBytes,
              structuralIndex: receipt.structuralIndex,
              capturedAt: new Date(receipt.capturedAt),
              expiresAt: new Date(receipt.expiresAt),
              encryptedPayload: durable.encryptedPayload,
              encryptedPayloadDigest: durable.encryptedPayloadDigest,
              responseStatus: fetched.status(),
            });
            captureDurable = true;
            await route.fulfill({ response: fetched, body });
            settleOwned({ receipt });
          } catch (error) {
            settleOwned({ error: error instanceof Error ? error : new Error(String(error)) });
            await route.abort("failed").catch(() => undefined);
          }
          return;
        }
        blockedWrite = true;
        return route.abort("blockedbyclient");
      };
      try {
        await session.page.route("**/*", gate);
        await target.click({ noWaitAfter: true, timeout: command.timeoutMs });
        const owned = await bounded(
          ownedResult,
          command.timeoutMs,
          "BROWSER_V2_MUTATION_REQUEST_TIMEOUT",
        );
        if ("error" in owned) throw owned.error;
        const { receipt } = owned;
        await session.page
          .waitForLoadState("domcontentloaded", { timeout: Math.min(command.timeoutMs, 5_000) })
          .catch(() => undefined);
        await session.page.waitForTimeout(100);
        const successorObservation = await this.observe(session);
        return {
          effectId: effect.effect.id,
          capture: receipt,
          replay: false,
          writeRequests: writeCount,
          blockedAdditionalWrite: blockedWrite,
          successorObservation,
        };
      } catch (error) {
        if (!captureDurable) session.authority.abort(protectionBarrier);
        if (dispatchBegan && !captureDurable)
          await this.effects
            .markUnknown(effect.effect.id, session.ownerGeneration, "dispatch_result_unresolved")
            .catch(() => undefined);
        else if (!dispatchBegan)
          await this.effects
            .determine(
              effect.effect.id,
              session.ownerGeneration,
              "not_applied",
              "pre_dispatch_failure",
            )
            .catch(() => undefined);
        throw error;
      } finally {
        await session.page.unrouteAll({ behavior: "ignoreErrors" });
      }
    }
    return {
      effectId: effect.effect.id,
      replay: true,
      ...(await this.effects.recoverEffect(effect.effect.id)),
    };
  }

  private async readOnlyInteraction(
    session: ActiveSession,
    action: () => Promise<void>,
  ): Promise<void> {
    let blocked = false;
    let actionStarted = false;
    let lastNetworkActivity = Date.now();
    const pendingReads = new Set<Request>();
    const isRead = (request: Request) => ["GET", "HEAD", "OPTIONS"].includes(request.method());
    const onRequest = (request: Request) => {
      if (!actionStarted || !isRead(request)) return;
      pendingReads.add(request);
      lastNetworkActivity = Date.now();
    };
    const onRequestSettled = (request: Request) => {
      if (!pendingReads.delete(request)) return;
      lastNetworkActivity = Date.now();
    };
    const gate = async (route: import("playwright").Route) => {
      if (["GET", "HEAD", "OPTIONS"].includes(route.request().method())) return route.continue();
      blocked = true;
      return route.abort("blockedbyclient");
    };
    session.page.on("request", onRequest);
    session.page.on("requestfinished", onRequestSettled);
    session.page.on("requestfailed", onRequestSettled);
    await session.page.route("**/*", gate);
    try {
      actionStarted = true;
      lastNetworkActivity = Date.now();
      await action();
      const deadline = Date.now() + 10_000;
      while (pendingReads.size > 0 || Date.now() - lastNetworkActivity < 100) {
        if (Date.now() >= deadline) throw new Error("BROWSER_V2_READ_ONLY_SETTLE_TIMEOUT");
        await session.page.waitForTimeout(25);
      }
    } finally {
      session.page.off("request", onRequest);
      session.page.off("requestfinished", onRequestSettled);
      session.page.off("requestfailed", onRequestSettled);
      await session.page.unrouteAll({ behavior: "ignoreErrors" });
    }
    if (blocked) throw new Error("BROWSER_V2_MUTATION_REQUIRES_COMMIT");
  }

  private async captureDom(
    session: ActiveSession,
    effectId: string,
    reference: string,
  ): Promise<Record<string, unknown>> {
    const protectionBarrier = session.authority.begin(effectId);
    let captured = false;
    try {
      const effect = await this.effects.observeEffect(effectId);
      if (effect.session_id !== session.sessionId || effect.dispatch_state !== "acknowledged")
        throw new Error("BROWSER_V2_DOM_CAPTURE_EFFECT_INVALID");
      await this.effects.assertCaptureSlotAvailable(effectId, session.sessionId);
      const handle = this.handle(session, reference);
      const structured = await handle.evaluate((root) => {
        const result: Record<string, unknown> = {};
        const stack: Array<{ element: Element; depth: number; target: Record<string, unknown> }> = [
          { element: root, depth: 0, target: result },
        ];
        let nodes = 0;
        while (stack.length > 0) {
          const current = stack.pop()!;
          nodes += 1;
          if (nodes > 500 || current.depth > 12) {
            current.target.truncated = true;
            continue;
          }
          const html = current.element as HTMLElement;
          const form = current.element as HTMLInputElement;
          let ownText = "";
          for (const node of current.element.childNodes) {
            if (node.nodeType === Node.TEXT_NODE) ownText += `${node.textContent ?? ""} `;
          }
          current.target.tag = current.element.tagName.toLowerCase();
          current.target.role = current.element.getAttribute("role") ?? "";
          current.target.label = current.element.getAttribute("aria-label") ?? "";
          ownText = ownText.trim().slice(0, 4_000);
          if (ownText) current.target.text = ownText;
          if (["INPUT", "TEXTAREA", "SELECT"].includes(current.element.tagName))
            current.target.value = form.value;
          current.target.visible = Boolean(
            html.offsetWidth || html.offsetHeight || html.getClientRects().length,
          );
          const elements = [...current.element.children].slice(0, 100);
          if (elements.length > 0) {
            const children: Array<Record<string, unknown>> = [];
            for (let index = 0; index < elements.length; index += 1) children.push({});
            current.target.children = children;
            for (let index = elements.length - 1; index >= 0; index -= 1) {
              stack.push({
                element: elements[index]!,
                depth: current.depth + 1,
                target: children[index]!,
              });
            }
          }
        }
        return result;
      });
      sanitizeDomSemanticHints(structured, session.authority);
      const body = Buffer.from(JSON.stringify(structured));
      const receipt = await session.vault.captureHttpResponse({
        effectId,
        method: "DOM",
        url: session.page.url(),
        status: 200,
        contentType: "application/vnd.scry.dom+json",
        body,
        protectionBarrier,
      });
      captured = true;
      const durable = await session.vault.exportDurableCapture(receipt.captureId);
      await this.effects.registerCapture({
        effectId,
        ownerGeneration: session.ownerGeneration,
        captureId: receipt.captureId,
        evidenceVersion: 1,
        objectKey: `postgres://browser_captures/${receipt.captureId}`,
        ciphertextDigest: durable.encryptedPayloadDigest,
        authenticatedMetadata: {
          receiptDigest: digest(receipt),
          documentEpoch: session.documentEpoch,
          storedReceipt: durable.storedReceipt,
        },
        contentClass: receipt.contentClass,
        byteSize: receipt.bodyBytes,
        structuralIndex: receipt.structuralIndex,
        capturedAt: new Date(receipt.capturedAt),
        expiresAt: new Date(receipt.expiresAt),
        encryptedPayload: durable.encryptedPayload,
        encryptedPayloadDigest: durable.encryptedPayloadDigest,
      });
      return { effectId, capture: receipt };
    } catch (error) {
      if (!captured) session.authority.abort(protectionBarrier);
      throw error;
    }
  }

  private async publish(
    session: ActiveSession,
    effectId: string,
    captureId: string,
    selections: BrowserOutputSelection[],
  ): Promise<Record<string, unknown>> {
    const outputs = await session.vault.publish(captureId, selections, {
      deferReleaseUntilDurablePublication: true,
    });
    const protectedPlaintext: Record<string, string> = {};
    try {
      for (const [name, reference] of Object.entries(outputs.protectedOutputs))
        await session.vault.deliverProtectedToBrowser(reference.reference, {
          fill: async (value) => {
            protectedPlaintext[name] = value;
          },
        });
      const persisted = await this.effects.publishOutputs({
        effectId,
        ownerGeneration: session.ownerGeneration,
        captureId,
        selectionDigest: digest(selections),
        publicOutputs: outputs.publicOutputs,
        protectedOutputs: protectedPlaintext,
        decisions: outputs.decisions,
      });
      await session.vault.releasePublishedBarrier(captureId);
      await session.recorder.checkpoint();
      return {
        effectId,
        captureId,
        publicOutputs: outputs.publicOutputs,
        protectedReferences: persisted.protectedReferences,
      };
    } finally {
      for (const key of Object.keys(protectedPlaintext)) protectedPlaintext[key] = "";
    }
  }

  private async discard(
    session: ActiveSession,
    effectId: string,
    captureId: string,
  ): Promise<Record<string, unknown>> {
    await this.effects.discardCapture({
      effectId,
      ownerGeneration: session.ownerGeneration,
      captureId,
    });
    const discarded = await session.vault.discard(captureId);
    return { effectId, captureId, phase: discarded.receipt.phase };
  }
}

function sanitizeDomSemanticHints(
  root: Record<string, unknown>,
  authority: ProtectionAuthority,
): void {
  const stack: Record<string, unknown>[] = [root];
  while (stack.length > 0) {
    const current = stack.pop()!;
    const label = current.label;
    delete current.label;
    if (typeof label === "string") current.semanticHint = safeDomSemanticHint(label, authority);
    const children = current.children;
    if (Array.isArray(children)) {
      for (const child of children)
        if (child && typeof child === "object" && !Array.isArray(child))
          stack.push(child as Record<string, unknown>);
    }
  }
}

function safeDomSemanticHint(input: string, authority: ProtectionAuthority): string {
  const normalized = input.replace(/\s+/gu, " ").trim();
  if (!normalized) return "";
  if (normalized.length > 200 || /[\u0000-\u001f\u007f]/u.test(normalized))
    return "[PROTECTED:SEMANTIC_HINT]";
  return authority.sanitize(normalized, "database_safe_field");
}

async function bounded<T>(operation: Promise<T>, timeoutMs: number, code: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(code)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
