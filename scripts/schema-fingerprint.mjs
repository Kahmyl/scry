import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";

const root = new URL("../apps/api/migrations-v2/", import.meta.url);
const migrationNames = (await readdir(root)).filter((name) => /^\d{4}-.+\.sql$/u.test(name)).sort();

if (migrationNames.length === 0) throw new Error("BROWSER_V2_MIGRATIONS_MISSING");

const migrations = await Promise.all(
  migrationNames.map(async (name) => ({
    name,
    source: await readFile(new URL(name, root), "utf8"),
  })),
);

process.stdout.write(
  `${createHash("sha256")
    .update(
      migrations.map(({ name, source }) => `${name}\n${source}`).join("\n-- next migration --\n"),
    )
    .digest("hex")}\n`,
);
