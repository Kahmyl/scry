import { mkdir, open, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

// Private quarantine storage. Durable evidence custody remains outside Veil.
export async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
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
