import path from "node:path";

export function requireSafeStorageKey(storageKey: string) {
  if (
    !storageKey ||
    path.isAbsolute(storageKey) ||
    storageKey.includes("\0") ||
    storageKey.split(/[\\/]/).includes("..")
  )
    throw new Error("Artifact storage key must be a safe relative path");
  return storageKey.replaceAll("\\", "/");
}

export function prefixedStorageKey(prefix: string | undefined, storageKey: string) {
  const safe = requireSafeStorageKey(storageKey);
  const normalizedPrefix = prefix?.replace(/^\/+|\/+$/g, "");
  return normalizedPrefix ? `${normalizedPrefix}/${safe}` : safe;
}
