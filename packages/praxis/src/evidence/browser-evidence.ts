import type { BrowserContext, Page } from "playwright";

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
          .filter((attribute) => [
            "role", "aria-label", "aria-expanded", "aria-haspopup", "aria-selected",
            "aria-checked", "placeholder",
          ].includes(attribute.name))
          .map((attribute) => [attribute.name, attribute.value.slice(0, 200)]),
      );
      for (const attribute of [...element.attributes]) element.removeAttribute(attribute.name);
      for (const [name, value] of semanticAttributes) element.setAttribute(name, value);
      if (inputType) element.setAttribute("type", safeInputType(inputType));
    });
    return `<!doctype html>${clone.outerHTML}`;

    function safeInputType(value: string) {
      return [
        "button", "checkbox", "color", "date", "file", "hidden", "image", "month",
        "number", "password", "radio", "range", "reset", "submit", "time", "week",
      ].includes(value) ? value : "text";
    }
  });
}
