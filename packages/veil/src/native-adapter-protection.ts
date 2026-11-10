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
    cleanApi(value: unknown) {
      const protectedKeys =
        /(?:password|passwd|secret|token|authorization|cookie|api[-_]?key|card[-_]?number|cvv)|^(?:pan|session(?:id)?|credentials?|access[-_]?link|reset[-_]?url|recovery[-_]?url)$/i;
      let nodes = 0;
      const fields = (v: unknown, depth = 0): unknown => {
        if (
          ++nodes > 2048 ||
          depth > 16 ||
          (Array.isArray(v) && v.length > 1000) ||
          (v && typeof v === "object" && Object.keys(v).length > 1000)
        )
          throw Error("API_RESPONSE_STRUCTURE_CAPACITY");
        return Array.isArray(v)
          ? v.slice(0, 1000).map((x) => fields(x, depth + 1))
          : v && typeof v === "object"
            ? Object.fromEntries(
                Object.entries(v)
                  .slice(0, 1000)
                  .map(([key, item]) => [
                    key,
                    protectedKeys.test(key) ||
                    (/^(?:code|otp|pin)$/i.test(key) && /^\d{4,8}$/.test(String(item)))
                      ? "[PROTECTED:API_RESPONSE]"
                      : fields(item, depth + 1),
                  ]),
              )
            : typeof v === "number"
              ? classifier.sanitize(String(v)) === String(v)
                ? v
                : classifier.sanitize(String(v))
              : clean(v);
      };
      if (value && typeof value === "object" && "body" in value && typeof value.body === "string") {
        let body: unknown = value.body;
        try {
          body = JSON.stringify(fields(JSON.parse(value.body)));
        } catch (error) {
          if (error instanceof Error && error.message === "API_RESPONSE_STRUCTURE_CAPACITY")
            return clean({
              ...value,
              body: "[UNAVAILABLE:RESPONSE_STRUCTURE_CAPACITY]",
              bodyIssue: "response_structure_capacity",
            });
          if (
            "contentType" in value &&
            typeof value.contentType === "string" &&
            /json/i.test(value.contentType)
          )
            return clean({
              ...value,
              body: "[UNAVAILABLE:INVALID_JSON]",
              bodyIssue: "invalid_json",
            });
          body = classifier.sanitize(
            value.body.replace(
              /"(?:password|passwd|secret|token|access_token|refresh_token|api_key|authorization|cookie)"\s*:\s*"(?:\\.|[^"\\])*"/giu,
              "[PROTECTED:API_RESPONSE]",
            ),
          );
        }
        return clean({ ...value, body });
      }
      return clean(value);
    },
    script:
      "(()=>{" +
      maskSource +
      "\ninstallNativeMasks(" +
      JSON.stringify(Object.values(secrets)) +
      ");})()",
  };
}
