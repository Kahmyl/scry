import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes, createCipheriv, createDecipheriv, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { observationTools } from "./action-kind.mjs";

export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, canonical(value[k])]),
    );
  return value;
}
export const digest = (value) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
export class Store {
  constructor(root) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.root = root;
    const keyFile = path.join(root, "private.key");
    if (!existsSync(keyFile)) writeFileSync(keyFile, randomBytes(32), { flag: "wx", mode: 0o600 });
    this.key = readFileSync(keyFile);
    this.db = new DatabaseSync(path.join(root, "receipts.sqlite"));
    // SQLite owns the OS lock for the connection lifetime. Process death releases
    // it automatically; PID files are unsafe across container PID namespaces.
    try {
      this.db.exec(
        "PRAGMA locking_mode=EXCLUSIVE; PRAGMA journal_mode=WAL; BEGIN EXCLUSIVE; COMMIT;",
      );
    } catch (error) {
      this.db.close();
      if (error.errcode === 5) throw new Error("CANDIDATE_OWNER_ALREADY_RUNNING");
      throw error;
    }
    this.db.exec(`PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,workspace TEXT NOT NULL,environment TEXT NOT NULL,state TEXT NOT NULL,generation INTEGER NOT NULL,created INTEGER NOT NULL,evidence TEXT,findings TEXT NOT NULL DEFAULT '[]');
      CREATE TABLE IF NOT EXISTS actions(run_id TEXT NOT NULL,id TEXT NOT NULL,hash TEXT NOT NULL,input TEXT NOT NULL,state TEXT NOT NULL,receipt TEXT NOT NULL,created INTEGER NOT NULL,PRIMARY KEY(run_id,id));
      CREATE TABLE IF NOT EXISTS secrets(environment TEXT NOT NULL,id TEXT NOT NULL,cipher BLOB NOT NULL,PRIMARY KEY(environment,id));`);
    // A process restart cannot safely replay an action that may already have run.
    for (const row of this.db
      .prepare("SELECT run_id,id,receipt FROM actions WHERE state IN ('admitted','running')")
      .all()) {
      const receipt = JSON.parse(row.receipt);
      this.update(row.run_id, row.id, {
        ...receipt,
        execution: "unknown",
        businessOutcome: observationTools.has(receipt.tool) ? "not_inferred" : "unknown",
        observation: "unavailable",
        reason: "parent_restarted",
        finished: Date.now(),
      });
    }
    this.db
      .prepare("UPDATE runs SET state='interrupted',generation=generation+1 WHERE state='active'")
      .run();
  }
  create(workspace, environment) {
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO runs(id,workspace,environment,state,generation,created) VALUES(?,?,?,'active',1,?)",
      )
      .run(id, workspace, environment, Date.now());
    return this.run(id, workspace);
  }
  run(id, workspace) {
    const row = this.db.prepare("SELECT * FROM runs WHERE id=? AND workspace=?").get(id, workspace);
    if (!row) throw new Error("RUN_NOT_FOUND");
    return {
      ...row,
      evidence: row.evidence ? JSON.parse(row.evidence) : null,
      findings: JSON.parse(row.findings),
    };
  }
  admit(run, id, tool, args, safeArgs) {
    const hash = digest({ tool, args });
    const previous = this.db
      .prepare("SELECT * FROM actions WHERE run_id=? AND id=?")
      .get(run.id, id);
    if (previous) {
      if (previous.hash !== hash) throw new Error("ACTION_ID_CONFLICT");
      return { replay: true, receipt: JSON.parse(previous.receipt) };
    }
    if (run.state !== "active") throw new Error("RUN_NOT_ACTIVE");
    const receipt = {
      actionId: id,
      runId: run.id,
      tool,
      execution: "admitted",
      observation: "pending",
      businessOutcome: "not_inferred",
      admitted: Date.now(),
      generation: run.generation,
    };
    this.db
      .prepare(
        "INSERT INTO actions(run_id,id,hash,input,state,receipt,created) VALUES(?,?,?,?,?,?,?)",
      )
      .run(
        run.id,
        id,
        hash,
        JSON.stringify({ tool, args: safeArgs }),
        "admitted",
        JSON.stringify(receipt),
        Date.now(),
      );
    return { replay: false, receipt };
  }
  update(run, id, receipt) {
    this.db
      .prepare("UPDATE actions SET state=?,receipt=? WHERE run_id=? AND id=?")
      .run(receipt.execution, JSON.stringify(receipt), run, id);
    return receipt;
  }
  actions(run) {
    return this.db
      .prepare("SELECT receipt FROM actions WHERE run_id=? ORDER BY created,rowid")
      .all(run)
      .map((r) => JSON.parse(r.receipt));
  }
  finish(run, workspace, state, evidence) {
    this.run(run, workspace);
    this.db
      .prepare("UPDATE runs SET state=?,evidence=?,generation=generation+1 WHERE id=?")
      .run(state, JSON.stringify(evidence), run);
    return this.run(run, workspace);
  }
  finding(run, workspace, finding) {
    const row = this.run(run, workspace);
    row.findings.push({ ...finding, created: Date.now() });
    this.db.prepare("UPDATE runs SET findings=? WHERE id=?").run(JSON.stringify(row.findings), run);
  }
  putSecret(environment, id, value) {
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const encrypted = Buffer.concat([
      iv,
      cipher.update(value, "utf8"),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
    this.db.prepare("INSERT OR REPLACE INTO secrets VALUES(?,?,?)").run(environment, id, encrypted);
  }
  secrets(environment) {
    return Object.fromEntries(
      this.db
        .prepare("SELECT id,cipher FROM secrets WHERE environment=?")
        .all(environment)
        .map((row) => {
          const bytes = Buffer.from(row.cipher),
            decipher = createDecipheriv("aes-256-gcm", this.key, bytes.subarray(0, 12));
          decipher.setAuthTag(bytes.subarray(-16));
          return [
            row.id,
            Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString(
              "utf8",
            ),
          ];
        }),
    );
  }
  close() {
    this.db.close();
  }
}
