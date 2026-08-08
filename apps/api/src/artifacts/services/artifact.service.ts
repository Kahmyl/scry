import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  UnsupportedMediaTypeException,
} from "@nestjs/common";
import { type ArtifactStore, type VeilEvidenceAdmissionProof } from "@scry/artifact";
import { veilEvidenceManifestSchema } from "@scry/contracts";
import { parse, serialize, type DefaultTreeAdapterMap } from "parse5";

import type { Principal } from "../../auth/index.js";
import { ScryRepository } from "../../access/index.js";
import { ARTIFACT_STORE } from "../artifact-storage.provider.js";

const MAX_TEXT_PAGE = 256 * 1024;

@Injectable()
export class ArtifactService {
  constructor(
    @Inject(ScryRepository) private readonly repository: ScryRepository,
    @Inject(ARTIFACT_STORE) private readonly store: ArtifactStore,
  ) {}

  async metadata(principal: Principal, artifactId: string) {
    const artifact = await this.repository.getArtifact(principal, artifactId);
    if (
      artifact.availability !== "available" ||
      artifact.destructionStatus !== "pending" ||
      !artifact.storageKey
    )
      throw new NotFoundException("Artifact is not available");
    const admission = veilEvidenceManifestSchema.safeParse(artifact.observation?.veilManifest);
    const admissionToken = artifact.observation?.veilAdmissionToken;
    const sanitation = artifact.observation?.veilSanitation;
    if (
      !admission.success ||
      typeof admissionToken !== "string" ||
      !sanitation ||
      typeof sanitation !== "object" ||
      admission.data.evidenceId !== artifact.id ||
      admission.data.contentDigest !== artifact.checksumSha256
    ) {
      throw new NotFoundException("Artifact has no valid Veil admission proof");
    }
    return {
      ...artifact,
      admission: {
        manifest: admission.data,
        sanitation: sanitation as Record<string, unknown>,
        token: admissionToken,
      },
    } as typeof artifact & {
      storageKey: string;
      contentType: string;
      admission: VeilEvidenceAdmissionProof;
    };
  }

  async range(principal: Principal, artifactId: string, range?: string) {
    const artifact = await this.metadata(principal, artifactId);
    const size = await this.store.size(artifact.storageKey, artifact.admission);
    const parsed = parseRange(range, size);
    const data = await this.store.getRange(
      artifact.storageKey,
      parsed.start,
      parsed.end - parsed.start + 1,
      artifact.admission,
    );
    return { artifact, data, size, ...parsed };
  }

  async text(principal: Principal, artifactId: string, offset = 0, limit = 64 * 1024) {
    const artifact = await this.metadata(principal, artifactId);
    this.requireText(artifact.contentType);
    const size = await this.store.size(artifact.storageKey, artifact.admission);
    const safeOffset = Math.min(Math.max(0, offset), size);
    const safeLimit = Math.min(Math.max(1, limit), MAX_TEXT_PAGE);
    const data = await this.store.getRange(
      artifact.storageKey,
      safeOffset,
      safeLimit,
      artifact.admission,
    );
    const nextOffset = safeOffset + data.byteLength;
    return {
      artifactId,
      offset: safeOffset,
      nextOffset,
      eof: nextOffset >= size,
      sizeBytes: size,
      text: new TextDecoder().decode(data),
    };
  }

  async search(principal: Principal, artifactId: string, query: string, maxMatches = 20) {
    if (!query || query.length > 500)
      throw new UnsupportedMediaTypeException("Search query must contain 1-500 characters");
    const artifact = await this.metadata(principal, artifactId);
    this.requireText(artifact.contentType);
    const size = await this.store.size(artifact.storageKey, artifact.admission);
    const matches: Array<{ offset: number; context: string }> = [];
    const chunkSize = 256 * 1024;
    let offset = 0;
    let carry = "";
    while (offset < size && matches.length < Math.min(maxMatches, 100)) {
      const bytes = await this.store.getRange(
        artifact.storageKey,
        offset,
        chunkSize,
        artifact.admission,
      );
      const text = carry + new TextDecoder().decode(bytes);
      let index = 0;
      while (
        (index = text.indexOf(query, index)) >= 0 &&
        matches.length < Math.min(maxMatches, 100)
      ) {
        const absolute = Math.max(
          0,
          offset - Buffer.byteLength(carry) + Buffer.byteLength(text.slice(0, index)),
        );
        matches.push({
          offset: absolute,
          context: text.slice(Math.max(0, index - 120), index + query.length + 120),
        });
        index += Math.max(1, query.length);
      }
      carry = text.slice(-Math.max(query.length - 1, 256));
      offset += bytes.byteLength;
      if (!bytes.byteLength) break;
    }
    return { artifactId, query, matches, truncated: matches.length >= Math.min(maxMatches, 100) };
  }

  async extractHtml(principal: Principal, artifactId: string, selector: string) {
    const normalized = validateSimpleSelector(selector);
    const artifact = await this.metadata(principal, artifactId);
    if (!artifact.contentType.includes("html"))
      throw new UnsupportedMediaTypeException("Artifact is not HTML");
    const html = new TextDecoder().decode(
      await this.store.get(artifact.storageKey, artifact.admission),
    );
    const matches = extractHtml(html, normalized).slice(0, 100);
    return { artifactId, selector, matches, truncated: matches.length === 100 };
  }

  private requireText(contentType: string) {
    if (
      !contentType.startsWith("text/") &&
      !contentType.includes("json") &&
      !contentType.includes("xml")
    ) {
      throw new UnsupportedMediaTypeException("Artifact is not textual");
    }
  }
}

function parseRange(value: string | undefined, size: number) {
  if (!value) return { start: 0, end: Math.max(0, size - 1), partial: false };
  const match = /^bytes=(\d+)-(\d*)$/.exec(value);
  if (!match) throw new Error("Invalid Range header");
  const start = Number(match[1]);
  const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (start > end || start >= size) throw new Error("Requested range is not satisfiable");
  return { start, end, partial: true };
}

function validateSimpleSelector(selector: string) {
  const value = selector.trim();
  if (!/^(?:[a-zA-Z][\w-]*|#[\w-]+|\.[\w-]+|\[data-testid=["'][^"']{1,200}["']\])$/.test(value)) {
    throw new BadRequestException({
      code: "ARTIFACT_SELECTOR_UNSUPPORTED",
      message: 'Selector must be a tag, #id, .class, or [data-testid="value"]',
    });
  }
  return value;
}

type HtmlNode = DefaultTreeAdapterMap["node"];
type HtmlElement = DefaultTreeAdapterMap["element"];

function extractHtml(html: string, selector: string) {
  const document = parse(html);
  const matches: Array<{ html: string; text: string }> = [];
  visit(document, (element) => {
    if (!matchesSelector(element, selector)) return;
    matches.push({
      html: serialize(element).slice(0, 256 * 1024),
      text: normalizedText(element).slice(0, 256 * 1024),
    });
  });
  return matches;
}

function visit(node: HtmlNode, inspect: (element: HtmlElement) => void) {
  if ("tagName" in node) inspect(node);
  if ("childNodes" in node) for (const child of node.childNodes) visit(child, inspect);
}

function matchesSelector(element: HtmlElement, selector: string) {
  if (selector.startsWith("#")) return attribute(element, "id") === selector.slice(1);
  if (selector.startsWith("."))
    return (attribute(element, "class") ?? "").split(/\s+/).includes(selector.slice(1));
  if (selector.startsWith("["))
    return attribute(element, "data-testid") === selector.match(/["']([^"']+)["']/)![1];
  return element.tagName.toLowerCase() === selector.toLowerCase();
}

function attribute(element: HtmlElement, name: string) {
  return element.attrs.find((candidate) => candidate.name === name)?.value;
}

function normalizedText(node: HtmlNode): string {
  if (node.nodeName === "#text" && "value" in node) return node.value;
  if (!("childNodes" in node)) return "";
  return node.childNodes.map(normalizedText).join(" ").replace(/\s+/g, " ").trim();
}
