import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
const classifierSource = readFileSync(
  new URL("../../../packages/veil/src/classifier.ts", import.meta.url),
  "utf8",
);
const { SensitiveValueClassifier } = await import(
  "data:text/javascript;base64," +
    Buffer.from(stripTypeScriptTypes(classifierSource)).toString("base64")
);
const maskSource = readFileSync(
  new URL("../../../packages/veil/src/native-mask-runtime.js", import.meta.url),
  "utf8",
);
export function protector(secrets) {
  const classifier = new SensitiveValueClassifier({
    protectedValues: secrets,
    patterns: [
      [
        "url-access-secret",
        /\b(?:requesttoken|csrf[_-]?token|access[_-]?token|auth[_-]?token|sessionid|api[_-]?key)=[^&\s"'<>]+/giu,
      ],
    ],
  });
  const clean = (value) =>
    typeof value === "string"
      ? classifier.sanitize(value)
      : Array.isArray(value)
        ? value.map(clean)
        : value && typeof value === "object"
          ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clean(v)]))
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
