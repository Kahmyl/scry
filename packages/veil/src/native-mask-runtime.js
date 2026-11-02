function installNativeMasks(initial) {
  const host = globalThis;
  if (host.__scryNativeRefresh) {
    for (const secret of initial) host.__scryNativeRefresh(secret);
    return;
  }
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
        // An empty secret control contains no secret to cover.
        if (!element.value) continue;
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
            // Round outward to capture pixels; a fractional edge must not blend
            // the source text back into an otherwise opaque cover.
            const ratio =
              Number.isFinite(host.devicePixelRatio) && host.devicePixelRatio > 0
                ? host.devicePixelRatio
                : 1;
            const left = Math.floor(Math.max(0, rect.left) * ratio) / ratio;
            const top = Math.floor(Math.max(0, rect.top) * ratio) / ratio;
            const right = Math.ceil(Math.min(innerWidth, rect.right) * ratio) / ratio;
            const bottom = Math.ceil(Math.min(innerHeight, rect.bottom) * ratio) / ratio;
            const block = document.createElement("div");
            // The base removes the original pixels. Only the synthetic stripe
            // decoration is blurred: never sample the page with backdrop-filter.
            block.style.cssText = `position:absolute;left:${left}px;top:${top}px;width:${right - left}px;height:${bottom - top}px;background:#e5e9ed;opacity:1;mix-blend-mode:normal;isolation:isolate;overflow:hidden;pointer-events:none;`;
            const texture = document.createElement("div");
            texture.style.cssText =
              "position:absolute;left:0;right:0;top:50%;height:9px;transform:translateY(-50%);background:repeating-linear-gradient(90deg,transparent 0px,transparent 20px,#9ba6b0 20px,#9ba6b0 76px,transparent 76px,transparent 108px);filter:blur(7px);pointer-events:none;";
            block.append(texture);
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
