import { createHash } from "node:crypto";

export function workflowDigest(value: unknown): string {
  const canonical = (v: unknown): string => {
    if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
    if (v && typeof v === "object")
      return (
        "{" +
        Object.keys(v)
          .sort()
          .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
          .map((k) => JSON.stringify(k) + ":" + canonical((v as Record<string, unknown>)[k]))
          .join(",") +
        "}"
      );
    return JSON.stringify(v);
  };
  return createHash("sha256").update(canonical(value)).digest("hex");
}

export function immutableWorkflowInput<T>(value: T): T {
  const cloned = structuredClone(value);
  const freeze = (v: unknown): void => {
    if (v && typeof v === "object") {
      for (const child of Object.values(v)) freeze(child);
      Object.freeze(v);
    }
  };
  freeze(cloned);
  return cloned;
}
