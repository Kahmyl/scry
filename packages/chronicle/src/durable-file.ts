import { mkdir, open, realpath, rename } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export async function ensurePrivateDirectory(directory: string): Promise<void> {
  const firstCreated = await mkdir(path.resolve(directory), { recursive: true, mode: 0o700 });
  if (!firstCreated) return;
  // Sync every newly linked directory, including its first existing parent.
  // Syncing only the leaf can otherwise lose a new session tree on power loss.
  let current = await realpath(directory);
  const anchor = await realpath(path.dirname(firstCreated));
  while (true) {
    const handle = await open(current, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (current === anchor) break;
    const parent = path.dirname(current);
    if (parent === current) throw new Error("evidence_directory_anchor_invalid");
    current = parent;
  }
}

export async function durableWrite(target: string, data: string | Buffer): Promise<void> {
  await ensurePrivateDirectory(path.dirname(target));
  const temporary = `${target}.partial-${randomUUID()}`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, target);
  const directory = await open(path.dirname(target), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
