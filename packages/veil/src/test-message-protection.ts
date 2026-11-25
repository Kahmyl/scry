// Secrecy is independent of the bounded navigable-reference list.
import { parseFragment } from "parse5";
import { SensitiveValueClassifier } from "./classifier.js";
const codeKey =
  /^(?:(?:verification|authentication|security|login|one[-_ ]?time|recovery)[-_ ]?code|otp)$/i;
const privateKey =
  /^(?:authorization|proxy-authorization|cookie|set-cookie|password|passwd|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|recovery[_-]?codes?)$/i;
const accessKey =
  /^(?:token|secret|code|key|ticket|access[_-]?token|refresh[_-]?token|api[_-]?key|invit(?:e|ation)[_-]?(?:token|code)|verification[_-]?(?:token|code)|reset[_-]?(?:token|code))$/i;
const codeText =
  /\b(?:verification|authentication|security|login|one[- ]time|otp|recovery)\s*(?:code|password)?\s*(?:is|:|=|-)?\s*(\d{4,8})\b/gi;
export function protectTestMessage(value: unknown) {
  const candidates: Array<{
      kind: "code" | "link";
      value: string;
      source: "html_href" | "markdown" | "text" | "code";
      label?: string;
    }> = [],
    secrets = new Set<string>();
  const htmlAliases: Array<{ decoded: string; source: string }> = [];
  let nodes = 0,
    htmlNodes = 0;
  const addSecret = (s: string) => {
    if (s) secrets.add(s);
    if (secrets.size > 256) throw Error("MESSAGE_SECRET_LIMIT");
  };
  const candidate = (
    kind: "code" | "link",
    s: string,
    source: "html_href" | "markdown" | "text" | "code" = kind === "code" ? "code" : "text",
    label?: string,
  ) => {
    addSecret(s);
    const existing = candidates.find((x) => x.value === s);
    if (existing) {
      if (source === "html_href" || (source === "markdown" && existing.source === "text"))
        Object.assign(existing, { source, label });
    } else if (candidates.length < 20)
      candidates.push({ kind, value: s, source, ...(label ? { label } : {}) });
  };
  const url = (raw: string, source: "html_href" | "markdown" | "text" = "text", label?: string) => {
    if (raw.length > 8192) throw Error("MESSAGE_URL_LIMIT");
    try {
      let absolute = true;
      let u: URL;
      try {
        u = new URL(raw);
      } catch {
        absolute = false;
        // Relative links have no trusted origin. Protect them without inventing
        // a usable absolute destination for the browser.
        u = new URL(raw, "https://message.invalid/");
      }
      // The fragment is separate from searchParams. Support ordinary fragment
      // parameters and router fragments with a query, without decoding an entire
      // URL (which would change delimiters and the claim's actual value).
      const fragment = u.hash.slice(1);
      const queryStart = fragment.indexOf("?");
      const assignment = fragment.indexOf("=");
      const fragmentParams = new URLSearchParams(
        queryStart >= 0 && (assignment < 0 || queryStart < assignment)
          ? fragment.slice(queryStart + 1)
          : fragment,
      );
      const parameters = [...u.searchParams, ...fragmentParams];
      const pathClaim = /\/(?:invite|verify|reset|activate|confirm)[^?]*\/[a-z0-9_-]{12,}/i.test(
        u.pathname,
      );
      if (parameters.some(([key]) => accessKey.test(key)) || pathClaim) {
        for (const [key, claim] of parameters)
          if (accessKey.test(key) && claim.length >= 4 && !/PROTECTED/i.test(claim))
            addSecret(claim);
        // A previously sanitized projection is not the original claim. Never
        // fabricate a handoff from a placeholder while upgrading old events.
        if (
          absolute &&
          /^https?:\/\//i.test(raw.trim()) &&
          (pathClaim ||
            parameters.some(([key, claim]) => accessKey.test(key) && claim.length > 0)) &&
          ["http:", "https:"].includes(u.protocol) &&
          !u.username &&
          !u.password &&
          !/\[PROTECTED|%5bPROTECTED/i.test(raw)
        )
          candidate("link", u.href, source, label);
        addSecret(raw);
        return true;
      }
    } catch (e: any) {
      if (e.message?.startsWith("MESSAGE_")) throw e;
    }
  };
  const plainText = (s: string) => {
    let found = false;
    for (const m of s.matchAll(codeText)) {
      candidate("code", m[1]!);
      found = true;
    }
    for (const m of s.matchAll(/https?:\/\/[^\s"'<>\\]+/gi)) {
      let raw = m[0];
      let source: "markdown" | "text" = "text";
      let label: string | undefined;
      // A recognized Markdown destination has its own closing delimiter. Keep
      // balanced parentheses inside the URL; never trim arbitrary token bytes.
      const prefix = s.slice(0, m.index);
      if (/\]\($/.test(prefix) || /[\[(]$/.test(prefix)) {
        source = "markdown";
        label = /\[([^\]\r\n]{0,120})\]\($/.exec(prefix)?.[1];
        const opening = prefix.endsWith("[") ? "[" : "(",
          closing = opening === "[" ? "]" : ")";
        let depth = 0;
        for (let i = 0; i < raw.length; i++) {
          if (raw[i] === opening) depth++;
          if (raw[i] === closing && depth-- === 0) {
            addSecret(raw);
            raw = raw.slice(0, i);
            break;
          }
        }
      }
      found = url(raw, source, label) || found;
    }
    return found;
  };
  const text = (s: string) => {
    if (s.length > 16384) throw Error("MESSAGE_STRING_LIMIT");
    if (/<[a-z][\s\S]*>/i.test(s)) {
      const walk = (n: any) => {
        if (++htmlNodes > 2048) throw Error("MESSAGE_HTML_LIMIT");
        for (const a of n.attrs ?? []) {
          const location = n.sourceCodeLocation?.attrs?.[a.name];
          if (location)
            htmlAliases.push({
              decoded: a.value,
              source: s.slice(location.startOffset, location.endOffset),
            });
          if (a.name === "href") {
            const label = (node: any): string =>
              node.nodeName === "#text"
                ? (node.value ?? "")
                : (node.childNodes ?? []).map(label).join("").slice(0, 4096);
            url(a.value, "html_href", label(n));
          }
        }
        // HTML source aliases must be masked too: equals, ampersands, protocol
        // characters or the claim itself can all use character references.
        if (n.nodeName === "#text") {
          plainText(n.value ?? "");
          const location = n.sourceCodeLocation;
          if (location)
            htmlAliases.push({
              decoded: n.value ?? "",
              source: s.slice(location.startOffset, location.endOffset),
            });
        }
        if (htmlAliases.length > 4096) throw Error("MESSAGE_HTML_LIMIT");
        for (const c of n.childNodes ?? []) walk(c);
        if (n.content) walk(n.content);
      };
      walk(parseFragment(s, { sourceCodeLocationInfo: true }));
      return;
    }
    plainText(s);
  };
  const collect = (v: any, key = "", depth = 0) => {
    if (++nodes > 4096 || depth > 32) throw Error("MESSAGE_TREE_LIMIT");
    if (codeKey.test(key) && /^\d{4,8}$/.test(String(v))) candidate("code", String(v));
    if (typeof v === "string") text(v);
    else if (Array.isArray(v)) for (const child of v) collect(child, "", depth + 1);
    else if (v && typeof v === "object")
      for (const [k, child] of Object.entries(v)) collect(child, k, depth + 1);
  };
  try {
    if (Buffer.byteLength(JSON.stringify(value)) > 65536) throw Error("MESSAGE_BYTE_LIMIT");
    collect(value);
    const classifierForSecrets = () =>
      new SensitiveValueClassifier({
        protectedValues: Object.fromEntries([...secrets].map((s, i) => ["test_" + i, s])),
      });
    const decodedClassifier = classifierForSecrets();
    for (const alias of htmlAliases)
      if (decodedClassifier.sanitize(alias.decoded) !== alias.decoded) addSecret(alias.source);
    const classifier = classifierForSecrets();
    const visit = (v: any, key = ""): any => {
      if (privateKey.test(key) || (codeKey.test(key) && /^\d{4,8}$/.test(String(v))))
        return "[PROTECTED]";
      if (typeof v === "string") return classifier.sanitize(v);
      if (typeof v === "number" && secrets.has(String(v))) return "[PROTECTED]";
      if (Array.isArray(v)) return v.map((x) => visit(x));
      if (v && typeof v === "object")
        return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, visit(x, k)]));
      return v;
    };
    return {
      safe: visit(value),
      candidates: candidates.map(({ label, ...candidate }) => ({
        ...candidate,
        ...(label
          ? {
              label: classifier
                .sanitize(label)
                .replace(/[\u0000-\u001f\u007f]/g, " ")
                .trim()
                .slice(0, 120),
            }
          : {}),
      })),
    };
  } catch {
    return { safe: "[PROTECTED:MESSAGE_LIMIT]", candidates: [] };
  }
}
