import {
  constants,
  closeSync,
  existsSync,
  fchmodSync,
  fchownSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Mechanical alias migration only: never parse, generate, rotate or print keys.
export function preserveBrowserKeyConfig(envPath, apply = false) {
  const stat = lstatSync(envPath);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0)
    throw new Error("private regular environment file required");
  const original = readFileSync(envPath, "utf8");
  const pairs = [
    ["BROWSER_V2_PROTECTED_KEYS_JSON", "SCRY_BROWSER_PROTECTED_KEYS_JSON"],
    ["BROWSER_V2_PROTECTED_KEY_VERSION", "SCRY_BROWSER_PROTECTED_KEY_ID"],
  ];
  const additions = [];
  for (const [oldName, newName] of pairs) {
    const get = (name) => {
      const lines = original.split(/\r?\n/).filter((line) => line.startsWith(`${name}=`));
      if (lines.length > 1) throw new Error("duplicate key configuration entries");
      return lines[0]?.slice(name.length + 1);
    };
    const oldValue = get(oldName);
    const newValue = get(newName);
    if (!oldValue?.trim()) throw new Error("legacy key configuration is missing");
    if (newValue !== undefined && newValue !== oldValue)
      throw new Error("key configuration conflicts; refusing rotation");
    if (newValue === undefined) additions.push(`${newName}=${oldValue}`);
  }
  if (!additions.length || !apply) return { changed: false, pendingAliases: additions.length };
  const backup = `${envPath}.before-browser-key-aliases`;
  const temporary = `${envPath}.key-aliases-${process.pid}`;
  if (existsSync(backup))
    throw new Error("key configuration backup already exists; review before retry");
  const writePrivate = (path, contents) => {
    const fd = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      fchownSync(fd, stat.uid, stat.gid);
      fchmodSync(fd, 0o600);
      writeFileSync(fd, contents);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  };
  writePrivate(backup, original);
  try {
    writePrivate(
      temporary,
      `${original}${original.endsWith("\n") ? "" : "\n"}${additions.join("\n")}\n`,
    );
    // Refuse if another operator changed the source during preparation.
    if (readFileSync(envPath, "utf8") !== original)
      throw new Error("environment changed during key preservation");
    renameSync(temporary, envPath);
    const directory = openSync(dirname(envPath), constants.O_RDONLY);
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
  return { changed: true, preservedAliases: additions.length, backupCreated: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (!process.argv[2] || ![undefined, "--apply"].includes(process.argv[3]))
      throw new Error("usage: preserve-browser-key-config.mjs /absolute/environment [--apply]");
    if (!process.argv[2].startsWith("/")) throw new Error("absolute environment path required");
    console.log(
      JSON.stringify(preserveBrowserKeyConfig(process.argv[2], process.argv[3] === "--apply")),
    );
  } catch (error) {
    // Never forward filesystem exceptions that could include configuration data.
    console.error(
      `Key configuration preservation refused: ${error.code ? "filesystem operation failed" : error.message}`,
    );
    process.exitCode = 1;
  }
}
