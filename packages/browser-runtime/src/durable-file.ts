import { mkdir, open, readFile, rename } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

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

export async function durableAppend(target: string, value: unknown): Promise<void> {
  await ensurePrivateDirectory(path.dirname(target));
  const handle = await open(target, "a", 0o600);
  try {
    await handle.write(`${JSON.stringify(value)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function readJsonLines<T>(target: string): Promise<T[]> {
  let text: string;
  try {
    text = await readFile(target, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  }
  try {
    return text
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as T);
  } catch {
    throw new Error("durable_json_lines_invalid");
  }
}

export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
