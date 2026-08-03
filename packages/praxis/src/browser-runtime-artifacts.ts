import { createHash } from "node:crypto";

// Source text is intentional: browser initialization must not acquire TSX/esbuild helpers.
export const visualRedactionInitScript = String.raw`(() => {
  const shadow = Element.prototype.attachShadow;
  if (!globalThis.__scryVeilShadowGuardInstalled) {
    Object.defineProperty(globalThis, "__scryVeilShadowGuardInstalled", { value: true });
    Element.prototype.attachShadow = function (init) {
      if (init && init.mode === "closed") this.setAttribute("data-scry-closed-shadow-host", "true");
      return shadow.call(this, init);
    };
  }
  const install = function () {
    if (!document.documentElement) return;
    if (document.getElementById("scry-visual-redaction-style")) return;
    const style = document.createElement("style");
    style.id = "scry-visual-redaction-style";
    style.textContent = '[data-scry-redacted="true"],[data-scry-closed-shadow-host="true"],iframe,canvas,video,svg{color:transparent!important;-webkit-text-fill-color:transparent!important;background:#000!important;border-color:#000!important;caret-color:transparent!important;text-shadow:none!important;visibility:visible!important;filter:brightness(0)!important;opacity:1!important}svg *{fill:#000!important;stroke:#000!important}#scry-sensitive-overlay{position:fixed!important;inset:0!important;z-index:2147483647!important;display:grid!important;place-items:center!important;color:#fff!important;background:#000!important;font:600 16px/1.4 system-ui,sans-serif!important;pointer-events:none!important}';
    document.documentElement.appendChild(style);
    try {
      if (sessionStorage.getItem("scry-sensitive-overlay") === "1" && !document.getElementById("scry-sensitive-overlay")) {
        const overlay = document.createElement("div");
        overlay.id = "scry-sensitive-overlay";
        overlay.setAttribute("role", "presentation");
        overlay.setAttribute("aria-hidden", "true");
        overlay.textContent = "Protected information hidden by Scry";
        document.documentElement.appendChild(overlay);
      }
    } catch (_) {}
  };
  install();
  document.addEventListener("DOMContentLoaded", install, { once: true });
})();`;

export function inspectBrowserRuntimeArtifacts(namedSources: Record<string, string>) {
  const diagnostics = Object.entries(namedSources).flatMap(([subsystem, source]) =>
    ["__name", "[native code]"]
      .filter((token) => source.includes(token))
      .map((token) => ({
        code: "BROWSER_RUNTIME_FREE_VARIABLE",
        subsystem,
        message: `Browser artifact contains forbidden token ${token}.`,
      })),
  );
  return {
    healthy: diagnostics.length === 0,
    runtimeHash: createHash("sha256").update(stable(namedSources)).digest("hex"),
    capabilityManifestHash: createHash("sha256")
      .update(stable({ artifacts: Object.keys(namedSources).sort(), version: 1 }))
      .digest("hex"),
    diagnostics,
  };
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

/** Playwright selects its bundled Chromium when the channel option is omitted. */
export function playwrightBrowserChannel(channel?: string) {
  return channel && channel !== "chromium" ? channel : undefined;
}
