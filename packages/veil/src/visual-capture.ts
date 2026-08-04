import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  VEIL_CONTRACT_VERSION,
  veilCapturePermitSchema,
  type VeilCapturePermit,
  type VeilContext,
  type VeilVisualRegion,
} from "@scry/contracts";
import type { Page } from "playwright";

type CaptureBinding = Pick<
  VeilContext,
  "browserContextId" | "pageId" | "frameId" | "documentEpoch"
>;
type Discovery = Readonly<{
  documentIdentity: string;
  revision: number;
  regions: readonly VeilVisualRegion[];
}>;
type StoredPermit = {
  permit: VeilCapturePermit;
  binding: CaptureBinding;
  discoveryDigest: string;
  state: "issued" | "captured";
};

export class VeilVisualCaptureError extends Error {
  override name = "VeilVisualCaptureError";
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Owns visual discovery, pre-capture masking and short-lived capture authorization. */
export class VeilVisualCaptureAuthority {
  private readonly permits = new Map<string, StoredPermit>();

  constructor(
    private readonly policyDigest: string,
    private readonly now: () => number = Date.now,
    private readonly ttlMs = 500,
  ) {
    if (!/^[a-f0-9]{64}$/.test(policyDigest))
      throw new VeilVisualCaptureError("VEIL_POLICY_INVALID", "A valid policy digest is required");
    if (!Number.isInteger(ttlMs) || ttlMs < 50 || ttlMs > 5_000)
      throw new VeilVisualCaptureError(
        "VEIL_CAPTURE_TTL_INVALID",
        "Capture permit TTL must be between 50 and 5000ms",
      );
  }

  async issue(
    page: Page,
    binding: CaptureBinding,
  ): Promise<Readonly<{ permit: VeilCapturePermit; regions: readonly VeilVisualRegion[] }>> {
    assertBinding(binding);
    const discovery = await discoverAndMask(page);
    const discoveryDigest = digestDiscovery(discovery);
    const issuedAt = this.now();
    const permit = veilCapturePermitSchema.parse({
      schemaVersion: VEIL_CONTRACT_VERSION,
      token: `veil_capture_${randomBytes(32).toString("base64url")}`,
      policyDigest: this.policyDigest,
      contextDigest: digest(binding),
      ...binding,
      maskDigest: digest(discovery.regions),
      regionCount: discovery.regions.length,
      issuedAt: new Date(issuedAt).toISOString(),
      expiresAt: new Date(issuedAt + this.ttlMs).toISOString(),
    });
    this.permits.set(permit.token, {
      permit,
      binding: { ...binding },
      discoveryDigest,
      state: "issued",
    });
    return { permit, regions: discovery.regions };
  }

  async validate(page: Page, rawPermit: VeilCapturePermit, binding: CaptureBinding): Promise<void> {
    const permit = veilCapturePermitSchema.parse(rawPermit);
    const stored = this.permits.get(permit.token);
    if (!stored || stored.state !== "issued" || !samePermit(stored.permit, permit))
      throw new VeilVisualCaptureError(
        "VEIL_CAPTURE_PERMIT_INVALID",
        "Capture permit is invalid, forged, or already used",
      );
    if (permit.policyDigest !== this.policyDigest)
      throw new VeilVisualCaptureError(
        "VEIL_CAPTURE_POLICY_STALE",
        "Capture permit policy is stale",
      );
    if (this.now() >= Date.parse(permit.expiresAt))
      throw new VeilVisualCaptureError("VEIL_CAPTURE_PERMIT_EXPIRED", "Capture permit has expired");
    if (digest(binding) !== permit.contextDigest || digest(binding) !== digest(stored.binding)) {
      throw new VeilVisualCaptureError(
        "VEIL_CAPTURE_CONTEXT_MISMATCH",
        "Capture permit does not match the browser, page, frame, or document epoch",
      );
    }
    const discovery = await discoverAndMask(page);
    if (
      digestDiscovery(discovery) !== stored.discoveryDigest ||
      digest(discovery.regions) !== permit.maskDigest
    ) {
      this.permits.delete(permit.token);
      throw new VeilVisualCaptureError(
        "VEIL_CAPTURE_DOCUMENT_CHANGED",
        "Visual regions or document geometry changed after permit issuance",
      );
    }
  }

  async capture<T>(
    page: Page,
    permit: VeilCapturePermit,
    binding: CaptureBinding,
    operation: () => Promise<T>,
  ): Promise<T> {
    await this.validate(page, permit, binding);
    const result = await operation();
    const stored = this.permits.get(permit.token);
    if (!stored || stored.state !== "issued")
      throw new VeilVisualCaptureError(
        "VEIL_CAPTURE_PERMIT_INVALID",
        "Capture permit disappeared during capture",
      );
    stored.state = "captured";
    return result;
  }

  revoke(permit: VeilCapturePermit): boolean {
    return this.permits.delete(permit.token);
  }

  admissionBinding(
    permit: VeilCapturePermit,
  ): Readonly<{ capturePermitDigest: string; maskDigest: string; documentEpoch: number }> {
    const stored = this.permits.get(permit.token);
    if (!stored || stored.state !== "captured" || !samePermit(stored.permit, permit))
      throw new VeilVisualCaptureError(
        "VEIL_CAPTURE_NOT_COMPLETED",
        "Admission requires a successfully consumed capture permit",
      );
    this.permits.delete(permit.token);
    return Object.freeze({
      capturePermitDigest: digest(permit),
      maskDigest: permit.maskDigest,
      documentEpoch: permit.documentEpoch,
    });
  }
}

async function discoverAndMask(page: Page): Promise<Discovery> {
  if (page.isClosed())
    throw new VeilVisualCaptureError(
      "VEIL_CAPTURE_PAGE_LOST",
      "Cannot authorize capture for a closed page",
    );
  // tsx/esbuild can preserve nested browser-function names with a free `__name`
  // helper. Install a locked, temporary realm-local implementation so no page
  // script can replace it while this evaluated artifact executes.
  await page.evaluate(
    "if(!Object.prototype.hasOwnProperty.call(globalThis,'__name'))Object.defineProperty(globalThis,'__name',{value:function(value){return value},configurable:false,writable:false})",
  );
  const raw = await page.evaluate(() => {
    const root = globalThis as typeof globalThis & {
      __scryVeilVisualRevision?: number;
      __scryVeilVisualObserver?: MutationObserver;
    };
    const maskAttribute = "data-scry-veil-capture-mask";
    const ensureRuntime = () => {
      if (!document.getElementById("scry-veil-capture-mask-style")) {
        const style = document.createElement("style");
        style.id = "scry-veil-capture-mask-style";
        style.textContent = `[${maskAttribute}="true"]{color:transparent!important;-webkit-text-fill-color:transparent!important;background:#000!important;border-color:#000!important;caret-color:transparent!important;text-shadow:none!important;filter:brightness(0)!important;opacity:1!important;visibility:visible!important}`;
        (document.head || document.documentElement).appendChild(style);
      }
      if (!root.__scryVeilVisualObserver) {
        root.__scryVeilVisualRevision = 0;
        root.__scryVeilVisualObserver = new MutationObserver((records) => {
          const relevant = records.filter(
            (record) => !(record.type === "attributes" && record.attributeName === maskAttribute),
          );
          // Mutation observers run before the next paint. Conservatively mask
          // the changed subtree/owner immediately, then invalidate all permits.
          for (const record of relevant) {
            const target =
              record.target instanceof Element ? record.target : record.target.parentElement;
            if (target && !["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"].includes(target.tagName))
              target.setAttribute(maskAttribute, "true");
            if (record.type === "childList")
              for (const node of record.addedNodes) {
                if (
                  node instanceof Element &&
                  !["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"].includes(node.tagName)
                )
                  node.setAttribute(maskAttribute, "true");
              }
          }
          if (relevant.length > 0) {
            root.__scryVeilVisualRevision = (root.__scryVeilVisualRevision || 0) + 1;
          }
        });
        root.__scryVeilVisualObserver.observe(document, {
          subtree: true,
          childList: true,
          attributes: true,
          characterData: true,
        });
      }
    };
    ensureRuntime();
    const entries: Array<{
      element: Element;
      classification: "sensitive" | "unknown";
      surface: string;
    }> = [];
    const add = (element: Element, classification: "sensitive" | "unknown", surface: string) => {
      if (!element.isConnected || entries.some((entry) => entry.element === element)) return;
      entries.push({ element, classification, surface });
    };
    document
      .querySelectorAll("input,textarea,select,[contenteditable]:not([contenteditable='false'])")
      .forEach((element) => add(element, "sensitive", "editable"));
    document
      .querySelectorAll("[aria-label],[aria-describedby],[aria-labelledby]")
      .forEach((element) => {
        const aria = `${element.getAttribute("aria-label") || ""} ${element.getAttribute("aria-describedby") || ""} ${element.getAttribute("aria-labelledby") || ""}`;
        if (
          /password|passcode|secret|token|credential|card|account|health|medical|private|sensitive/i.test(
            aria,
          )
        )
          add(element, "sensitive", "aria_sensitive");
      });
    // Visible page-authored text has no trustworthy public provenance. It is unknown until
    // a future Veil-owned classifier positively classifies it, so capture fails closed by masking it.
    document.querySelectorAll("body *").forEach((element) => {
      if (["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"].includes(element.tagName)) return;
      const directText = Array.from(element.childNodes).some(
        (node) => node.nodeType === Node.TEXT_NODE && Boolean(node.textContent?.trim()),
      );
      if (directText) add(element, "unknown", "unclassified_text");
    });
    document
      .querySelectorAll("[data-scry-closed-shadow-host='true']")
      .forEach((element) => add(element, "unknown", "closed_shadow"));
    document
      .querySelectorAll("iframe")
      .forEach((element) => add(element, "unknown", "cross_origin_frame"));
    document.querySelectorAll("canvas").forEach((element) => add(element, "unknown", "canvas"));
    document.querySelectorAll("svg").forEach((element) => add(element, "unknown", "svg"));
    document.querySelectorAll("video").forEach((element) => add(element, "unknown", "video"));
    document.querySelectorAll("img,picture").forEach((element) => add(element, "unknown", "image"));
    document.querySelectorAll("body *").forEach((element) => {
      const own = getComputedStyle(element);
      const before = getComputedStyle(element, "::before");
      const after = getComputedStyle(element, "::after");
      const generatedImage = (style: CSSStyleDeclaration) =>
        style.backgroundImage !== "none" ||
        /url\(|image-set\(|gradient\(/i.test(style.content || "");
      if (generatedImage(own) || generatedImage(before) || generatedImage(after))
        add(element, "unknown", "css_image");
    });
    return {
      documentIdentity: `${location.origin}${location.pathname}${location.search}`,
      revision: root.__scryVeilVisualRevision || 0,
      regions: entries.map((entry, index) => {
        entry.element.setAttribute(maskAttribute, "true");
        const rect = entry.element.getBoundingClientRect();
        const style = getComputedStyle(entry.element);
        const masked =
          entry.element.getAttribute(maskAttribute) === "true" &&
          style.filter !== "none" &&
          style.visibility !== "hidden";
        return {
          regionId: `visual-region-${index + 1}`,
          classification: entry.classification,
          surface: entry.surface,
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          masked,
        };
      }),
    };
  });
  if (raw.regions.some((region) => !region.masked))
    throw new VeilVisualCaptureError(
      "VEIL_CAPTURE_MASK_UNPROVEN",
      "A sensitive or unknown visual region could not be proven masked",
    );
  return {
    documentIdentity: raw.documentIdentity,
    revision: raw.revision,
    regions: raw.regions as VeilVisualRegion[],
  };
}

function assertBinding(binding: CaptureBinding): void {
  if (
    !binding.browserContextId ||
    !binding.pageId ||
    !binding.frameId ||
    !Number.isInteger(binding.documentEpoch) ||
    binding.documentEpoch < 0
  ) {
    throw new VeilVisualCaptureError(
      "VEIL_CAPTURE_CONTEXT_INVALID",
      "Capture binding is incomplete or invalid",
    );
  }
}

// Mutation revision is diagnostic; permit validity is tied to the normalized
// document identity and actual classified/masked region geometry. Veil's own
// mask-attribute observer deliveries must not invalidate concurrent permits.
function digestDiscovery(discovery: Discovery): string {
  return digest({ documentIdentity: discovery.documentIdentity, regions: discovery.regions });
}
function digest(value: unknown): string {
  return createHash("sha256").update(stable(value)).digest("hex");
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
function samePermit(left: VeilCapturePermit, right: VeilCapturePermit): boolean {
  const a = Buffer.from(stable(left));
  const b = Buffer.from(stable(right));
  return a.length === b.length && timingSafeEqual(a, b);
}
