import { migrateBrowserBaseline, migrationFailureCode } from "./baseline-migration.js";

try {
  const result = await migrateBrowserBaseline({
    confirmation: process.env.SCRY_BROWSER_SCHEMA_CONFIRM,
    databaseUrl: process.env.SCRY_BROWSER_DATABASE_URL,
    expectedDatabase: process.env.SCRY_BROWSER_EXPECTED_DATABASE,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`${migrationFailureCode(error)}\n`);
  process.exitCode = 1;
}
