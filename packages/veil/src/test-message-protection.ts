// Secrecy is independent of the bounded navigable-reference list.
import { parseFragment } from "parse5";
import { SensitiveValueClassifier } from "./classifier.js";
const codeKey =
  /^(?:(?:verification|authentication|security|login|one[-_ ]?time|recovery)[-_ ]?code|otp)$/i;
const privateKey =
  /^(?:authorization|proxy-authorization|cookie|set-cookie|password|passwd|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|recovery[_-]?codes?)$/i;
const accessKey =
  /^(?:token|secret|code|key|ticket|access[_-]?token|refresh[_-]?token|api[_-]?key|invite(?:ation)?[_-]?(?:token|code)|verification[_-]?(?:token|code)|reset[_-]?(?:token|code))$/i;
const codeText =
  /\b(?:verification|authentication|security|login|one[- ]time|otp|recovery)\s*(?:code|password)?\s*(?:is|:|=|-)?\s*(\d{4,8})\b/gi;
export function protectTestMessage(value: unknown) {
  const candidates: Array<{ kind: "code" | "link"; value: string }> = [],
    secrets = new Set<string>();
  let nodes = 0,
    htmlNodes = 0;
  const addSecret = (s: string) => {
    if (s) secrets.add(s);
    if (secrets.size > 256) throw Error("MESSAGE_SECRET_LIMIT");
  };
  const candidate = (kind: "code" | "link", s: string) => {
    addSecret(s);
    if (candidates.length < 20 && !candidates.some((x) => x.value === s))
      candidates.push({ kind, value: s });
  };
  const url = (raw: string, navigable = true) => {
    if (raw.length > 8192) throw Error("MESSAGE_URL_LIMIT");
    try {
      const u = new URL(raw.replaceAll("&amp;", "&"));
      if (!["http:", "https:"].includes(u.protocol) || u.username || u.password) return;
      if (
        [...u.searchParams.keys()].some((k) => accessKey.test(k)) ||
        /\/(?:invite|verify|reset|activate|confirm)[^?]*\/[a-z0-9_-]{12,}/i.test(u.pathname)
      ) {
        if (navigable) candidate("link", u.href);
        else addSecret(u.href);
        addSecret(raw);
      }
    } catch (e: any) {
      if (e.message?.startsWith("MESSAGE_")) throw e;
    }
  };
  const text = (s: string) => {
    if (s.length > 16384) throw Error("MESSAGE_STRING_LIMIT");
    for (const m of s.matchAll(codeText)) candidate("code", m[1]!);
    if (/<[a-z][\s\S]*>/i.test(s)) {
      const walk = (n: any) => {
        if (++htmlNodes > 2048) throw Error("MESSAGE_HTML_LIMIT");
        for (const a of n.attrs ?? []) if (a.name === "href") url(a.value);
        if (n.nodeName === "#text")
          for (const m of (n.value ?? "").matchAll(/https?:\/\/[^\s"'<>\\]+/gi)) url(m[0]);
        for (const c of n.childNodes ?? []) walk(c);
      };
      walk(parseFragment(s));
      // Raw HTML encodings are secrecy aliases only. They must never become a
      // second, truncated navigation choice beside the parsed href.
      for (const m of s.matchAll(/https?:\/\/[^\s"'<>\\]+/gi)) url(m[0], false);
      return;
    }
    for (const m of s.matchAll(/https?:\/\/[^\s"'<>\\]+/gi)) url(m[0]);
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
    const classifier = new SensitiveValueClassifier({
      protectedValues: Object.fromEntries([...secrets].map((s, i) => ["test_" + i, s])),
    });
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
    return { safe: visit(value), candidates };
  } catch {
    return { safe: "[PROTECTED:MESSAGE_LIMIT]", candidates: [] };
  }
}
