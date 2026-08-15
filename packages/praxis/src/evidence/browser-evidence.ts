import type { VeilVisualRegion } from "@scry/contracts";
import type { BrowserContext, Page } from "playwright";

export type PraxisVisualMaskObservation = Readonly<{
  documentIdentity: string;
  revision: number;
  regions: readonly VeilVisualRegion[];
}>;

export async function observeAndMaskPraxisVisualRegions(
  page: Page,
): Promise<PraxisVisualMaskObservation> {
  if (page.isClosed()) throw new Error("PRAXIS_VISUAL_PAGE_LOST");
  await page.evaluate(
    "if(!Object.prototype.hasOwnProperty.call(globalThis,'__name'))Object.defineProperty(globalThis,'__name',{value:function(value){return value},configurable:false,writable:false})",
  );
  const observation = await page.evaluate(() => {
    const root = globalThis as typeof globalThis & {
      __scryVeilVisualRevision?: number;
      __scryVeilVisualObserver?: MutationObserver;
    };
    const maskAttribute = "data-scry-veil-capture-mask";
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
        for (const record of relevant) {
          const target =
            record.target instanceof Element ? record.target : record.target.parentElement;
          if (target && !["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"].includes(target.tagName))
            target.setAttribute(maskAttribute, "true");
          if (record.type === "childList")
            for (const node of record.addedNodes)
              if (
                node instanceof Element &&
                !["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"].includes(node.tagName)
              )
                node.setAttribute(maskAttribute, "true");
        }
        if (relevant.length)
          root.__scryVeilVisualRevision = (root.__scryVeilVisualRevision ?? 0) + 1;
      });
      root.__scryVeilVisualObserver.observe(document, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      });
    }
    const entries: Array<{
      element: Element;
      classification: "sensitive" | "unknown";
      surface: VeilVisualRegion["surface"];
    }> = [];
    const add = (
      element: Element,
      classification: "sensitive" | "unknown",
      surface: VeilVisualRegion["surface"],
    ) => {
      if (element.isConnected && !entries.some((entry) => entry.element === element))
        entries.push({ element, classification, surface });
    };
    document
      .querySelectorAll("input,textarea,select,[contenteditable]:not([contenteditable='false'])")
      .forEach((element) => add(element, "sensitive", "editable"));
    document
      .querySelectorAll("[aria-label],[aria-describedby],[aria-labelledby]")
      .forEach((element) => {
        const aria = `${element.getAttribute("aria-label") ?? ""} ${element.getAttribute("aria-describedby") ?? ""} ${element.getAttribute("aria-labelledby") ?? ""}`;
        if (
          /password|passcode|secret|token|credential|card|account|health|medical|private|sensitive/i.test(
            aria,
          )
        )
          add(element, "sensitive", "aria_sensitive");
      });
    document.querySelectorAll("body *").forEach((element) => {
      if (["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"].includes(element.tagName)) return;
      if (
        Array.from(element.childNodes).some(
          (node) => node.nodeType === Node.TEXT_NODE && Boolean(node.textContent?.trim()),
        )
      )
        add(element, "unknown", "unclassified_text");
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
      const generatedImage = (style: CSSStyleDeclaration) =>
        style.backgroundImage !== "none" ||
        /url\(|image-set\(|gradient\(/i.test(style.content || "");
      if (
        generatedImage(getComputedStyle(element)) ||
        generatedImage(getComputedStyle(element, "::before")) ||
        generatedImage(getComputedStyle(element, "::after"))
      )
        add(element, "unknown", "css_image");
    });
    return {
      documentIdentity: `${location.origin}${location.pathname}${location.search}`,
      revision: root.__scryVeilVisualRevision ?? 0,
      regions: entries.map((entry, index) => {
        entry.element.setAttribute(maskAttribute, "true");
        const rect = entry.element.getBoundingClientRect();
        const style = getComputedStyle(entry.element);
        return {
          regionId: `visual-region-${index + 1}`,
          classification: entry.classification,
          surface: entry.surface,
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          masked:
            entry.element.getAttribute(maskAttribute) === "true" &&
            style.filter !== "none" &&
            style.visibility !== "hidden",
        };
      }),
    };
  });
  if (observation.regions.some((region) => !region.masked))
    throw new Error("PRAXIS_VISUAL_MASK_NOT_OBSERVED");
  return {
    ...observation,
    regions: observation.regions.map((region) => ({ ...region, masked: true as const })),
  };
}

export function installPraxisInitScript(context: BrowserContext, content: string) {
  return context.addInitScript({ content });
}

export async function capturePraxisScreenshot(
  page: Page,
  path: string,
  options: { fullPage: boolean; timeoutMs?: number },
) {
  await page.screenshot({
    path,
    fullPage: options.fullPage,
    ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
  });
}

export function measurePraxisDocument(page: Page) {
  return page.evaluate(() => ({
    width: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth ?? 0),
    height: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0),
  }));
}

export function capturePraxisSanitizedStructure(page: Page): Promise<string> {
  return page.evaluate(() => {
    const source = document.documentElement;
    const clone = source.cloneNode(true) as HTMLElement;
    clone.querySelectorAll("script,style,noscript,template").forEach((element) => element.remove());
    const semanticTextSelector =
      "a,button,label,h1,h2,h3,[role=button],[role=link],[role=tab],[role=switch]";
    const walker = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_COMMENT);
    const remove: Node[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.nodeType === Node.COMMENT_NODE) {
        remove.push(node);
        continue;
      }
      const parent = node.parentElement;
      if (!parent?.closest(semanticTextSelector)) {
        remove.push(node);
        continue;
      }
      node.textContent = (node.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
      if (!node.textContent) remove.push(node);
    }
    remove.forEach((node) => node.parentNode?.removeChild(node));
    clone.querySelectorAll("*").forEach((element) => {
      const inputType = element instanceof HTMLInputElement ? element.type : undefined;
      const semanticAttributes = new Map(
        [...element.attributes]
          .filter((attribute) =>
            [
              "role",
              "aria-label",
              "aria-expanded",
              "aria-haspopup",
              "aria-selected",
              "aria-checked",
              "placeholder",
            ].includes(attribute.name),
          )
          .map((attribute) => [attribute.name, attribute.value.slice(0, 200)]),
      );
      for (const attribute of [...element.attributes]) element.removeAttribute(attribute.name);
      for (const [name, value] of semanticAttributes) element.setAttribute(name, value);
      if (inputType) element.setAttribute("type", safeInputType(inputType));
    });
    return `<!doctype html>${clone.outerHTML}`;

    function safeInputType(value: string) {
      return [
        "button",
        "checkbox",
        "color",
        "date",
        "file",
        "hidden",
        "image",
        "month",
        "number",
        "password",
        "radio",
        "range",
        "reset",
        "submit",
        "time",
        "week",
      ].includes(value)
        ? value
        : "text";
    }
  });
}

export function startPraxisScreencast(page: Page, path: string) {
  return page.screencast.start({ path });
}

export function stopPraxisScreencast(page: Page) {
  return page.screencast.stop();
}

export function startPraxisTrace(context: BrowserContext) {
  return context.tracing.start({ screenshots: true, snapshots: true, sources: false });
}

export function stopPraxisTrace(context: BrowserContext, path: string) {
  return context.tracing.stop({ path });
}
