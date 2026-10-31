import { readFileSync } from "node:fs";
import { SensitiveValueClassifier } from "./classifier.js";

const maskSource = readFileSync(new URL("./native-mask-runtime.js", import.meta.url), "utf8");
/** Narrow pixel/text policy capability. No keyring, application database, or
 * disclosure authority is needed inside the browser adapter process. */
export function createNativeAdapterProtector(secrets: Record<string, string>) {
  const classifier = new SensitiveValueClassifier({
    protectedValues: secrets,
    patterns: [
      [
        "url-access-secret",
        /\b(?:requesttoken|csrf[_-]?token|access[_-]?token|auth[_-]?token|sessionid|api[_-]?key)=[^&\s"'<>]+/giu,
      ],
    ],
  });
  const clean = (value: unknown): unknown =>
    typeof value === "string"
      ? classifier.sanitize(value)
      : Array.isArray(value)
        ? value.map(clean)
        : value && typeof value === "object"
          ? Object.fromEntries(Object.entries(value).map(([key, v]) => [key, clean(v)]))
          : value;
  return {
    clean,
    script:
      "(()=>{" +
      maskSource +
      "\ninstallNativeMasks(" +
      JSON.stringify(Object.values(secrets)) +
      ");})()",
  };
}
