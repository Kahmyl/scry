import { describe, expect, it } from "vitest";
import {
  validateMigrationTarget,
  validateMigrationCatalog,
  retainedBaselineMigrationNames,
  migrationFailureCode,
} from "../scripts/baseline-migration.js";

const valid = {
  confirmation: "CREATE_EMPTY_BASELINE",
  databaseUrl: "postgres://fixture:fixture@127.0.0.1/scry_fixture",
  expectedDatabase: "scry_fixture",
};
describe("migration target and operation catalog admission", () => {
  it("never prints arbitrary database, filesystem or connection diagnostics", () => {
    expect(migrationFailureCode(new Error("fixture-only-private-database-url"))).toBe(
      "SCRY_BROWSER_SCHEMA_MIGRATION_FAILED",
    );
    expect(migrationFailureCode(new Error("SCRY_BROWSER_MIGRATION_BUSY"))).toBe(
      "SCRY_BROWSER_MIGRATION_BUSY",
    );
    expect(migrationFailureCode(new Error("SCRY_BROWSER_PRIVATE_FIXTURE_SECRET"))).toBe(
      "SCRY_BROWSER_SCHEMA_MIGRATION_FAILED",
    );
    const hostile = new Error();
    Object.defineProperty(hostile, "message", {
      get() {
        throw new Error("fixture-only-private");
      },
    });
    expect(migrationFailureCode(hostile)).toBe("SCRY_BROWSER_SCHEMA_MIGRATION_FAILED");
  });
  it("accepts only explicit matching PostgreSQL identity and confirmation", () => {
    expect(() => validateMigrationTarget(valid)).not.toThrow();
    expect(() =>
      validateMigrationTarget({
        ...valid,
        databaseUrl: "postgresql://fixture@localhost/scry_fixture",
      }),
    ).not.toThrow();
  });
  it.each([
    [{ confirmation: undefined }, "SCHEMA_CONFIRM_REQUIRED"],
    [{ databaseUrl: undefined }, "DATABASE_URL_REQUIRED"],
    [{ expectedDatabase: undefined }, "EXPECTED_DATABASE_REQUIRED"],
    [{ databaseUrl: "https://fixture.invalid/scry_fixture" }, "DATABASE_IDENTITY_MISMATCH"],
    [{ databaseUrl: "not a database URL" }, "DATABASE_IDENTITY_MISMATCH"],
    [{ databaseUrl: "postgres://fixture@localhost/another_fixture" }, "DATABASE_IDENTITY_MISMATCH"],
  ] as const)("refuses an unsafe target before any migration access", (override, code) => {
    expect(() => validateMigrationTarget({ ...valid, ...override })).toThrow(code);
  });
  it("keeps stable operation names and allows additive numbered SQL without byte hashes", () => {
    expect(() => validateMigrationCatalog(retainedBaselineMigrationNames)).not.toThrow();
    expect(() =>
      validateMigrationCatalog([...retainedBaselineMigrationNames, "0009-native-custody.sql"]),
    ).not.toThrow();
  });
  it("rejects missing, renamed, reordered, duplicated, or skipped operation identifiers", () => {
    expect(() => validateMigrationCatalog([])).toThrow("MIGRATIONS_MISSING");
    const names = [...retainedBaselineMigrationNames];
    for (const catalog of [
      names.slice(1),
      [names[1]!, names[0]!, ...names.slice(2)],
      ["0001-renamed-applied-operation.sql", ...names.slice(1)],
      [...names, "0010-gap.sql"],
      [...names, names.at(-1)!],
      [...names, "0009-file.js"],
      [...names, "0009-UPPERCASE.sql"],
    ])
      expect(() => validateMigrationCatalog(catalog)).toThrow("MIGRATION_CATALOG_INVALID");
  });
});
