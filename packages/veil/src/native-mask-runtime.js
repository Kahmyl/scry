function installNativeMasks(initial) {
  const host = globalThis;
  const secrets = new Set(initial);
  let overlay;
  let scheduled = false;
  const sensitive =
    /password|passwd|passphrase|authtoken|accesstoken|sessioncookie|apikey|clientsecret|recoverycode|backupcode|onetimecode|cardnumber|ccnumber|cccsc|ccexp|creditcard|accountnumber|routingnumber|iban|cvv|cvc/iu;
  const refresh = (secret) => {
    if (secret) secrets.add(secret);
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      if (!document.documentElement) return;
      createOverlay();
      const root = overlay && roots.get(overlay);
      if (!root) return;
      const boxes = [];
      for (const element of Array.from(document.querySelectorAll("input,textarea")).slice(0, 500)) {
        const semantic =
          `${element.type ?? ""} ${element.name ?? ""} ${element.id} ${element.getAttribute("autocomplete") ?? ""} ${element.getAttribute("aria-label") ?? ""}`.replace(
            /[^a-z]/giu,
            "",
          );
        if (
          sensitive.test(semantic) ||
          element.hasAttribute("data-scry-secret") ||
          element.hasAttribute("data-scry-financial") ||
          [...secrets].some((value) => element.value?.includes(value))
        ) {
          if (element.getClientRects().length) boxes.push(element.getBoundingClientRect());
        }
      }
      const walker = document.createTreeWalker(
        document.body ?? document.documentElement,
        NodeFilter.SHOW_TEXT,
      );
      let node;
      let count = 0;
      while ((node = walker.nextNode()) && count++ < 3000) {
        const parent = node.parentElement;
        if (
          !parent ||
          parent.closest("script,style,noscript,textarea,input") ||
          !parent.getClientRects().length
        )
          continue;
        const text = node.textContent ?? "";
        const spans = [];
        for (const value of secrets) {
          let from = 0;
          while (value.length >= 3 && (from = text.indexOf(value, from)) >= 0) {
            spans.push([from, from + value.length]);
            from += value.length;
          }
        }
        const patterns = [
          /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/giu,
          /\b(?:sk_live_|sk_test_|ghp_)[A-Za-z0-9_-]{8,}/gu,
          /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]){11,30}\b/gu,
          /\b(?:card|account|routing)(?:[\s_-]*number)?\s*[:=]\s*((?:\d[ -]?){6,34})/giu,
          /\b(?:recovery|backup)[\s_-]*code\s*[:=]\s*([A-Z0-9][A-Z0-9-]{3,31})\b/giu,
        ];
        for (const pattern of patterns)
          for (const match of text.matchAll(pattern)) {
            const value = match[1] ?? match[0];
            const start = (match.index ?? 0) + match[0].lastIndexOf(value);
            spans.push([start, start + value.length]);
          }
        for (const [start, end] of spans) {
          const range = document.createRange();
          range.setStart(node, start);
          range.setEnd(node, end);
          boxes.push(...Array.from(range.getClientRects()));
        }
      }
      root.replaceChildren(
        ...boxes
          .filter(
            (rect) =>
              rect.width > 0 &&
              rect.height > 0 &&
              rect.bottom > 0 &&
              rect.right > 0 &&
              rect.top < innerHeight &&
              rect.left < innerWidth,
          )
          .map((rect) => {
            const block = document.createElement("div");
            block.style.cssText = `position:absolute;left:${Math.max(0, rect.left)}px;top:${Math.max(0, rect.top)}px;width:${Math.min(innerWidth, rect.right) - Math.max(0, rect.left)}px;height:${Math.min(innerHeight, rect.bottom) - Math.max(0, rect.top)}px;background:#000;pointer-events:none;`;
            return block;
          }),
      );
    });
  };
  const roots = new WeakMap();
  // Capture the root without exposing it or altering the page's attachShadow.
  const createOverlay = () => {
    if (!document.documentElement || overlay?.isConnected) return;
    overlay = document.createElement("div");
    overlay.setAttribute("aria-hidden", "true");
    overlay.style.cssText =
      "all:initial!important;position:fixed!important;inset:0!important;pointer-events:none!important;z-index:2147483647!important;contain:strict!important;";
    roots.set(overlay, overlay.attachShadow({ mode: "closed" }));
    document.documentElement.append(overlay);
  };
  host.__scryNativeRefresh = (secret) => {
    createOverlay();
    refresh(secret);
  };
  document.addEventListener("DOMContentLoaded", () => {
    createOverlay();
    refresh();
  });
  for (const event of ["input", "change", "scroll", "resize"])
    addEventListener(
      event,
      () => {
        createOverlay();
        refresh();
      },
      true,
    );
  new MutationObserver(() => {
    createOverlay();
    refresh();
  }).observe(document, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["value", "type", "name", "class", "style", "hidden"],
  });
  createOverlay();
  refresh();
}
