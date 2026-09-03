import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { BrowserCommitIntent, BrowserOutputSelection } from "@scry/contracts";
import {
  BrowserOwnerSupervisor,
  AuthenticatedEvidenceStore,
  EffectLedger,
  ProtectedCaptureVault,
  ProtectionAuthority,
  SensitiveValueClassifier,
  protectedValueVariants,
  sanitizeReplayValue,
  sanitizeToolResult,
  type HttpResponseCaptureInput,
} from "../src/index.js";

const RUN_ID = "00000000-0000-4000-8000-000000000101";
const SESSION_ID = "00000000-0000-4000-8000-000000000102";

function protectionAuthority(
  protectedValues: Readonly<Record<string, string>> = {},
  trustedPublicPolicies: readonly unknown[] = [],
) {
  return new ProtectionAuthority({
    scope: {
      projectId: "fixture-project",
      missionId: "fixture-mission",
      runId: RUN_ID,
      sessionId: SESSION_ID,
      origin: "https://fixture.example",
    },
    protectedValues,
    disclosureMode:
      trustedPublicPolicies.length > 0 ? "trusted_application_output" : "confidential",
  });
}

function publicGrant(semantic: string, fieldPath: readonly (string | number)[]) {
  return { semantic, fieldPath };
}

function capture(
  vault: ProtectedCaptureVault,
  input: Omit<HttpResponseCaptureInput, "protectionBarrier">,
) {
  return vault.captureHttpResponse({
    ...input,
    protectionBarrier: vault.beginProtection(input.effectId),
  });
}

function commitIntent(idempotencyKey = "fixture-create-001"): BrowserCommitIntent {
  return {
    runId: RUN_ID,
    browserSessionId: SESSION_ID,
    ownerGeneration: 1,
    documentEpoch: 2,
    idempotencyKey,
    authorization: "business",
    intentSummary: "Submit the visible create form once",
    expectedOrigin: "https://fixture.example",
    target: { frameId: "main", elementReference: "submit-1" },
  };
}

async function allFileText(directory: string): Promise<string> {
  const names = await readdir(directory, { recursive: true });
  const values: string[] = [];
  for (const name of names) {
    const target = path.join(directory, name);
    try {
      values.push(await readFile(target, "utf8"));
    } catch {
      // Directory entries are expected here.
    }
  }
  return values.join("\n");
}

describe("privacy surfaces", () => {
  it("removes exact, encoded, credential, and PII variants", () => {
    const protectedValues = { LOGIN: "person@example.test", TOKEN: "tok_fixture_1234567890" };
    const classifier = new SensitiveValueClassifier({ protectedValues });
    const input = `person@example.test ${encodeURIComponent("person@example.test")} Bearer abcdefghijklmnop password=hunter22`;
    const output = classifier.sanitize(input);
    for (const variant of protectedValueVariants(protectedValues))
      expect(output).not.toContain(variant);
    expect(output).toMatch(/PROTECTED:REFERENCE:LOGIN/);
    expect(output).toMatch(/PROTECTED:BEARER/);
    expect(output).toMatch(/PROTECTED:ASSIGNMENT-SECRET/);
  });

  it("does not treat ordinary URL paths and UUIDs as high-entropy secrets", () => {
    const classifier = new SensitiveValueClassifier();
    const url = "http://127.0.0.1:4500/inventory/v24-portfolio-gate-1-inventory/";
    const uuid = "a9d665c9-db83-4101-9259-5b157646b59f";
    expect(classifier.sanitize(url)).toBe(url);
    expect(classifier.sanitize(uuid)).toBe(uuid);
  });

  it("masks replay content and strips unsafe attributes without dropping the event", () => {
    const secret = "move-me-SECRET-772299";
    const classifier = new SensitiveValueClassifier({ protectedValues: { CANARY: secret } });
    const sanitized = sanitizeReplayValue(
      {
        type: 2,
        data: {
          node: {
            attributes: {
              id: `profile-${secret}`,
              href: `https://fixture.example/?secret=${secret}`,
              onclick: "fetch('https://attacker.example')",
              role: "dialog",
            },
            childNodes: [{ type: 3, textContent: secret }],
          },
        },
      },
      classifier,
    ) as { data: { node: { attributes: Record<string, unknown> } } };
    expect(JSON.stringify(sanitized)).not.toContain(secret);
    expect(sanitized.data.node.attributes).not.toHaveProperty("href");
    expect(sanitized.data.node.attributes).not.toHaveProperty("onclick");
    expect(sanitized.data.node.attributes.role).toBe("dialog");
    expect(sanitizeToolResult({ text: `Dashboard ${secret}` }, classifier)).toEqual({
      text: "Dashboard [PROTECTED:REFERENCE:CANARY]",
    });
  });

  it("preserves replay syntax while a protection barrier quarantines all content", () => {
    const sanitized = sanitizeReplayValue(
      {
        type: 2,
        data: {
          node: {
            type: 0,
            compatMode: "CSS1Compat",
            childNodes: [
              {
                type: 2,
                tagName: "main",
                attributes: { role: "dialog" },
                childNodes: [{ type: 3, textContent: "one-time secret" }],
              },
            ],
          },
        },
      },
      { sanitize: () => "[QUARANTINED]" },
    ) as {
      data: {
        node: {
          compatMode: string;
          childNodes: Array<{ tagName: string; childNodes: Array<{ textContent: string }> }>;
        };
      };
    };
    expect(sanitized.data.node.compatMode).toBe("CSS1Compat");
    expect(sanitized.data.node.childNodes[0]?.tagName).toBe("main");
    expect(sanitized.data.node.childNodes[0]?.childNodes[0]?.textContent).toBe("[QUARANTINED]");
  });
});

describe("effect truth", () => {
  it("persists admission before dispatch and returns the same effect for an idempotent replay", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "browser-effects-"));
    const first = await new EffectLedger({ directory }).initialize();
    const admission = await first.admit(commitIntent());
    expect(admission.replay).toBe(false);
    expect(admission.observation.truth.outcome).toBe("pending");

    const restarted = await new EffectLedger({ directory }).initialize();
    const replay = await restarted.admit(commitIntent());
    expect(replay.replay).toBe(true);
    expect(replay.effectId).toBe(admission.effectId);
    expect(restarted.observations()).toHaveLength(1);
  });

  it("blocks a second mutation while dispatch truth is unknown and allows late reconciliation", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "browser-unknown-"));
    const ledger = await new EffectLedger({ directory }).initialize();
    const { effectId } = await ledger.admit(commitIntent());
    await ledger.markDispatchStarted(effectId);
    expect((await ledger.markUnknown(effectId, "connection_lost")).truth.outcome).toBe("unknown");
    await expect(ledger.admit(commitIntent("fixture-create-002"))).rejects.toThrow(
      /effect_unresolved/,
    );

    expect((await ledger.markProviderResponse(effectId, 201)).truth.outcome).toBe("unknown");
    expect(
      (await ledger.markApplied(effectId, "documented reconciliation confirmed the resource")).truth
        .outcome,
    ).toBe("applied");
    const next = await ledger.admit(commitIntent("fixture-create-002"));
    expect(next.replay).toBe(false);
  });

  it("does not infer effect truth from HTTP status alone", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "browser-rejection-"));
    const ledger = await new EffectLedger({ directory }).initialize();
    const { effectId } = await ledger.admit(commitIntent());
    await ledger.markDispatchStarted(effectId);
    const observed = await ledger.markProviderResponse(effectId, 422);
    expect(observed.truth).toMatchObject({ dispatch: "acknowledged", outcome: "pending" });
    expect((await ledger.markNotApplied(effectId, "validated rejection body")).truth.outcome).toBe(
      "not_applied",
    );
  });

  it("sanitizes agent-authored intent before durable storage", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "browser-effect-sanitize-"));
    const secret = "tok_fixture_1234567890";
    const ledger = await new EffectLedger({
      directory,
      classifier: new SensitiveValueClassifier({ protectedValues: { CANARY: secret } }),
    }).initialize();
    await ledger.admit({ ...commitIntent(), intentSummary: `Create with ${secret}` });
    expect(await allFileText(directory)).not.toContain(secret);
  });
});

describe("protected response capture", () => {
  it("restores an unsettled quarantine before a replacement worker resumes", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "browser-barrier-restart-"));
    const firstAuthority = protectionAuthority();
    const first = await new ProtectedCaptureVault({
      directory,
      runId: RUN_ID,
      scopeId: "fixture-scope",
      authority: firstAuthority,
    }).initialize();
    await capture(first, {
      effectId: "00000000-0000-4000-8000-000000000119",
      method: "POST",
      url: "https://fixture.example/result",
      status: 201,
      contentType: "application/json",
      body: Buffer.from(JSON.stringify({ secret: "tiny7" })),
    });

    const replacementAuthority = protectionAuthority();
    const replacement = await new ProtectedCaptureVault({
      directory,
      runId: RUN_ID,
      scopeId: "fixture-scope",
      authority: replacementAuthority,
    }).initialize();
    expect(await replacement.resumeUnsettledProtection()).toBe(1);
    expect(replacementAuthority.hasActiveBarrier).toBe(true);
    expect(replacementAuthority.sanitize("visible page tiny7", "recording")).toBe("[QUARANTINED]");
  });

  it("restores an authenticated durable envelope after local worker state is lost", async () => {
    const key = randomBytes(32);
    const sourceDirectory = await mkdtemp(path.join(os.tmpdir(), "browser-envelope-source-"));
    const source = await new ProtectedCaptureVault({
      directory: sourceDirectory,
      runId: RUN_ID,
      scopeId: "fixture-scope",
      authority: protectionAuthority(),
      encryptionKey: key,
    }).initialize();
    const receipt = await capture(source, {
      effectId: "00000000-0000-4000-8000-000000000118",
      method: "POST",
      url: "https://fixture.example/result",
      status: 201,
      contentType: "application/json",
      body: Buffer.from(JSON.stringify({ credential: "durable-private-value" })),
    });
    const envelope = await source.exportDurableCapture(receipt.captureId);

    const replacementAuthority = protectionAuthority();
    const replacement = await new ProtectedCaptureVault({
      directory: await mkdtemp(path.join(os.tmpdir(), "browser-envelope-replacement-")),
      runId: RUN_ID,
      scopeId: "fixture-scope",
      authority: replacementAuthority,
      encryptionKey: key,
    }).initialize();
    await replacement.restoreDurableCapture(envelope);
    expect(await replacement.resumeUnsettledProtection()).toBe(1);
    expect(await replacement.receipt(receipt.captureId)).toEqual(receipt);
    expect(replacementAuthority.hasActiveBarrier).toBe(true);

    const corrupted = {
      ...envelope,
      encryptedPayload: Buffer.from(envelope.encryptedPayload),
    };
    corrupted.encryptedPayload[0] = (corrupted.encryptedPayload[0] ?? 0) ^ 0xff;
    const corruptReplacement = await new ProtectedCaptureVault({
      directory: await mkdtemp(path.join(os.tmpdir(), "browser-envelope-corrupt-")),
      runId: RUN_ID,
      scopeId: "fixture-scope",
      authority: protectionAuthority(),
      encryptionKey: key,
    }).initialize();
    await expect(corruptReplacement.restoreDurableCapture(corrupted)).rejects.toThrow(
      "capture_envelope_digest_invalid",
    );
  });

  it("durably captures redirecting HTML without assuming JSON or exposing its body", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "browser-html-response-"));
    const protectedText = "holdout-html-private-material-483920";
    const protectedPath = "tok_path_private_material_735190";
    const vault = await new ProtectedCaptureVault({
      directory,
      runId: RUN_ID,
      scopeId: "fixture-scope",
      authority: protectionAuthority(),
    }).initialize();
    const receipt = await capture(vault, {
      effectId: "00000000-0000-4000-8000-000000000120",
      method: "POST",
      url: `https://fixture.example/login/${protectedPath}`,
      status: 303,
      contentType: "text/html; charset=utf-8",
      body: Buffer.from(`<p>${protectedText}</p>`),
      redirectChain: [
        {
          status: 303,
          sameOrigin: true,
          targetDigest: "a".repeat(64),
        },
      ],
    });
    expect(receipt).toMatchObject({
      status: 303,
      contentClass: "http_text",
      structuralIndex: [
        expect.objectContaining({ path: ["$body"], kind: "string", classification: "uncertain" }),
      ],
      redirectChain: [{ status: 303, sameOrigin: true, targetDigest: "a".repeat(64) }],
    });
    expect(JSON.stringify(receipt)).not.toContain(protectedText);
    const persisted = await allFileText(directory);
    expect(persisted).not.toContain(protectedText);
    expect(persisted).not.toContain(protectedPath);
    await expect(
      vault.publish(receipt.captureId, [
        { key: "value", path: ["value"], classification: "protected" },
      ]),
    ).rejects.toThrow(/capture_output_mapping_unsupported:http_text/);
  });

  it("captures empty and bounded binary responses as evidence without interpretation", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "browser-non-json-response-"));
    const vault = await new ProtectedCaptureVault({
      directory,
      runId: RUN_ID,
      scopeId: "fixture-scope",
      authority: protectionAuthority(),
    }).initialize();
    const empty = await capture(vault, {
      effectId: "00000000-0000-4000-8000-000000000121",
      method: "POST",
      url: "https://fixture.example/save",
      status: 204,
      contentType: "application/octet-stream",
      body: Buffer.alloc(0),
    });
    const binary = await capture(vault, {
      effectId: "00000000-0000-4000-8000-000000000122",
      method: "POST",
      url: "https://fixture.example/export",
      status: 201,
      contentType: "application/pdf",
      body: Buffer.from([0, 1, 2, 3]),
    });
    expect(empty).toMatchObject({ contentClass: "http_empty", bodyBytes: 0 });
    expect(binary).toMatchObject({ contentClass: "http_binary", bodyBytes: 4 });
  });

  it("keeps DOM result text protected while exposing only harmless structure", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "browser-dom-response-"));
    const vault = await new ProtectedCaptureVault({
      directory,
      runId: RUN_ID,
      scopeId: "fixture-scope",
      authority: protectionAuthority(),
    }).initialize();
    const receipt = await capture(vault, {
      effectId: "00000000-0000-4000-8000-000000000123",
      method: "DOM",
      url: "https://fixture.example/result",
      status: 200,
      contentType: "application/vnd.scry.dom+json",
      body: Buffer.from(
        JSON.stringify({
          tag: "dialog",
          role: "dialog",
          semanticHint: "One-time result",
          text: "ABC-123",
          value: "short-private-value",
        }),
      ),
    });
    expect(receipt.contentClass).toBe("dom_region");
    expect(receipt.structuralIndex).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: ["tag"], classification: "uncertain" }),
        expect.objectContaining({ path: ["text"], classification: "uncertain" }),
        expect.objectContaining({ path: ["value"], classification: "uncertain" }),
      ]),
    );
    await expect(
      vault.publish(receipt.captureId, [
        { key: "result", semantic: "result", path: ["text"], classification: "public" },
      ]),
    ).rejects.toThrow("protection_public_admission_unavailable");
    const published = await vault.publish(receipt.captureId, [
      { key: "result", path: ["text"], classification: "protected" },
    ]);
    expect(published.publicOutputs).toEqual({});
    expect(published.protectedOutputs.result?.reference).toBeTruthy();
    expect(JSON.stringify(published)).not.toContain("ABC-123");
  });

  it("irreversibly discards an unneeded durable capture without exposing plaintext", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "browser-discard-"));
    const secret = "tok_fixture_discard_secret_443322";
    const vault = await new ProtectedCaptureVault({
      directory,
      runId: RUN_ID,
      scopeId: "fixture-scope",
      authority: protectionAuthority(),
    }).initialize();
    const receipt = await capture(vault, {
      effectId: "00000000-0000-4000-8000-000000000111",
      method: "POST",
      url: "https://fixture.example/activate",
      status: 200,
      contentType: "application/json",
      body: Buffer.from(JSON.stringify({ state: "active", internalToken: secret })),
    });
    const discarded = await vault.discard(receipt.captureId);
    expect(discarded.receipt.phase).toBe("discarded");
    const replay = await vault.discard(receipt.captureId);
    expect(replay.receipt.phase).toBe("discarded");
    await expect(
      readFile(path.join(directory, "captures", `${receipt.captureId}.raw.json`)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await allFileText(directory)).not.toContain(secret);
    const replacementAuthority = protectionAuthority();
    const replacement = await new ProtectedCaptureVault({
      directory,
      runId: RUN_ID,
      scopeId: "fixture-scope",
      authority: replacementAuthority,
    }).initialize();
    expect(await replacement.resumeUnsettledProtection()).toBe(0);
    expect(replacementAuthority.hasActiveBarrier).toBe(false);
  });

  it("exposes safe DOM semantic hints while keeping adjacent protected values opaque", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "browser-dom-hints-"));
    const secret = "tok_fixture_dom_secret_998877";
    const vault = await new ProtectedCaptureVault({
      directory,
      runId: RUN_ID,
      scopeId: "fixture-scope",
      authority: protectionAuthority(),
    }).initialize();
    const receipt = await capture(vault, {
      effectId: "00000000-0000-4000-8000-000000000110",
      method: "DOM",
      url: "https://fixture.example/workspaces",
      status: 200,
      contentType: "application/vnd.scry.dom+json",
      body: Buffer.from(
        JSON.stringify({
          children: [
            { semanticHint: "Workspace ID", text: "workspace-123" },
            { semanticHint: "Access token", text: secret },
          ],
        }),
      ),
    });
    expect(
      receipt.structuralIndex.find((node) => node.path.join(".") === "children.1.semanticHint"),
    ).toMatchObject({ classification: "uncertain", kind: "string" });
    expect(
      receipt.structuralIndex.find((node) => node.path.join(".") === "children.1.text"),
    ).toMatchObject({ classification: "uncertain" });
    expect(JSON.stringify(receipt)).not.toContain(secret);
  });

  it("uses sibling semantics to prevent an agent from publishing a short secret", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "browser-sibling-secret-"));
    const vault = await new ProtectedCaptureVault({
      directory,
      runId: RUN_ID,
      scopeId: "fixture-scope",
      authority: protectionAuthority({}, [publicGrant("resourceIdentity", ["unused"])]),
    }).initialize();
    const receipt = await capture(vault, {
      effectId: "00000000-0000-4000-8000-000000000108",
      method: "POST",
      url: "https://fixture.example/grants",
      status: 201,
      contentType: "application/json",
      body: Buffer.from(JSON.stringify({ grants: [{ kind: "client_secret", value: "brief7" }] })),
    });
    await expect(
      vault.publish(receipt.captureId, [
        {
          key: "resourceIdentity",
          semantic: "resourceIdentity",
          path: ["grants", 0, "value"],
          classification: "public",
        },
      ]),
    ).rejects.toThrow("protection_declassification_forbidden");
  });

  it("allows UUID-shaped resource identities to remain public while exact protected values still win", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "browser-public-identity-"));
    const secret = "tok_fixture_exact_secret_998877";
    const vault = await new ProtectedCaptureVault({
      directory,
      runId: RUN_ID,
      scopeId: "fixture-scope",
      authority: protectionAuthority({ SECRET: secret }, [
        publicGrant("credentialId", ["credentialId"]),
      ]),
    }).initialize();
    const receipt = await capture(vault, {
      effectId: "00000000-0000-4000-8000-000000000109",
      method: "POST",
      url: "https://fixture.example/items",
      status: 201,
      contentType: "application/json",
      body: Buffer.from(
        JSON.stringify({
          credentialId: "a75bf052-d88b-4d96-aab4-2be477a80c94",
          clientSecret: secret,
        }),
      ),
    });
    const published = await vault.publish(receipt.captureId, [
      {
        key: "credentialId",
        semantic: "credentialId",
        path: ["credentialId"],
        classification: "public",
      },
      { key: "clientSecret", path: ["clientSecret"], classification: "protected" },
    ]);
    expect(published.publicOutputs.credentialId).toBe("a75bf052-d88b-4d96-aab4-2be477a80c94");
    expect(JSON.stringify(published)).not.toContain(secret);
  });

  it("captures first, exposes a safe structural index, and atomically publishes typed outputs", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "browser-capture-"));
    const secret = "vtr-secret-live-canary-992871";
    const vault = await new ProtectedCaptureVault({
      directory,
      runId: RUN_ID,
      scopeId: "fixture-scope",
      authority: protectionAuthority({}, [
        publicGrant("credentialId", ["data", "credential", "id"]),
        publicGrant("clientId", ["data", "credential", "clientId"]),
      ]),
    }).initialize();
    const receipt = await capture(vault, {
      effectId: "00000000-0000-4000-8000-000000000103",
      method: "POST",
      url: "https://fixture.example/credentials?ignored=true",
      status: 201,
      contentType: "application/json; charset=utf-8",
      body: Buffer.from(
        JSON.stringify({
          data: { credential: { id: "cred-1", clientId: "client-1" }, clientSecret: secret },
        }),
      ),
    });
    expect(receipt.structuralIndex.find((node) => node.path.at(-1) === "id")).toMatchObject({
      classification: "uncertain",
      kind: "string",
    });
    expect(
      receipt.structuralIndex.find((node) => node.path.at(-1) === "clientSecret"),
    ).toMatchObject({
      classification: "uncertain",
      length: secret.length,
    });
    expect(JSON.stringify(receipt)).not.toContain(secret);
    expect(await allFileText(directory)).not.toContain(secret);

    const published = await vault.publish(receipt.captureId, [
      {
        key: "credentialId",
        semantic: "credentialId",
        path: ["data", "credential", "id"],
        classification: "public",
      },
      {
        key: "clientId",
        semantic: "clientId",
        path: ["data", "credential", "clientId"],
        classification: "public",
      },
      { key: "clientSecret", path: ["data", "clientSecret"], classification: "protected" },
    ]);
    expect(published.publicOutputs).toEqual({ credentialId: "cred-1", clientId: "client-1" });
    expect(JSON.stringify(published)).not.toContain(secret);
    let browserInput = "";
    const delivery = await vault.deliverProtectedToBrowser(
      published.protectedOutputs.clientSecret!.reference,
      {
        fill: async (value) => {
          browserInput = value;
        },
      },
    );
    expect(browserInput).toBe(secret);
    expect(delivery).toMatchObject({
      reference: published.protectedOutputs.clientSecret!.reference,
    });
    expect(JSON.stringify(delivery)).not.toContain(secret);
    expect(await allFileText(directory)).not.toContain(secret);
    expect((await vault.receipt(receipt.captureId)).phase).toBe("published");
    const replacementAuthority = protectionAuthority({}, [
      publicGrant("credentialId", ["data", "credential", "id"]),
      publicGrant("clientId", ["data", "credential", "clientId"]),
    ]);
    const replacement = await new ProtectedCaptureVault({
      directory,
      runId: RUN_ID,
      scopeId: "fixture-scope",
      authority: replacementAuthority,
    }).initialize();
    expect(await replacement.resumeUnsettledProtection()).toBe(1);
    expect(replacementAuthority.sanitize(`page ${secret}`, "recording")).not.toContain(secret);
  });

  it("retains omitted sensitive values without poisoning omitted ordinary values", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "browser-complete-publication-"));
    const secret = "vtr-secret-live-canary-112233";
    const clientIdentifier = "client-identifier-42";
    const authority = protectionAuthority({}, [
      publicGrant("credential_id", ["result", "credential_id"]),
    ]);
    const vault = await new ProtectedCaptureVault({
      directory,
      runId: RUN_ID,
      scopeId: "fixture-scope",
      authority,
    }).initialize();
    const receipt = await capture(vault, {
      effectId: "00000000-0000-4000-8000-000000000112",
      method: "POST",
      url: "https://fixture.example/credentials",
      status: 201,
      contentType: "application/json",
      body: Buffer.from(
        JSON.stringify({
          result: {
            credential_id: "cred-42",
            client_identifier: clientIdentifier,
            client_secret: secret,
          },
        }),
      ),
    });

    const published = await vault.publish(receipt.captureId, [
      {
        key: "credential_id",
        semantic: "credential_id",
        path: ["result", "credential_id"],
        classification: "public",
      },
      { key: "client_secret", path: ["result", "client_secret"], classification: "protected" },
    ]);

    expect(published.publicOutputs).toEqual({ credential_id: "cred-42" });
    expect(Object.keys(published.protectedOutputs)).toEqual(["client_secret"]);
    expect(authority.sanitize(`page ${clientIdentifier}`)).toContain(clientIdentifier);
    expect(JSON.stringify(published)).not.toContain(clientIdentifier);
    expect(await allFileText(directory)).not.toContain(clientIdentifier);
  });

  it("keeps every observation quarantined until output publication is durably acknowledged", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "browser-publication-barrier-"));
    const authority = protectionAuthority({}, [publicGrant("resource_id", ["result", "id"])]);
    const vault = await new ProtectedCaptureVault({
      directory,
      runId: RUN_ID,
      scopeId: "fixture-scope",
      authority,
    }).initialize();
    const receipt = await capture(vault, {
      effectId: "00000000-0000-4000-8000-000000000124",
      method: "POST",
      url: "https://fixture.example/resources",
      status: 201,
      contentType: "application/json",
      body: Buffer.from(JSON.stringify({ result: { id: "resource-42" } })),
    });
    const selection: BrowserOutputSelection = {
      key: "resource_id",
      semantic: "resource_id",
      path: ["result", "id"],
      classification: "public",
    };

    const first = await vault.publish(receipt.captureId, [selection], {
      deferReleaseUntilDurablePublication: true,
    });
    expect(first.publicOutputs).toEqual({ resource_id: "resource-42" });
    expect(authority.hasActiveBarrier).toBe(true);
    expect(authority.sanitize("Authenticated resource page", "agent_observation")).toBe(
      "[QUARANTINED]",
    );

    // A database write failure leaves the release call unmade. Retrying the same
    // publication is idempotent and must restore, rather than bypass, the barrier.
    const retried = await vault.publish(receipt.captureId, [selection], {
      deferReleaseUntilDurablePublication: true,
    });
    expect(retried).toEqual(first);
    expect(authority.hasActiveBarrier).toBe(true);
    expect(authority.sanitize("Authenticated resource page", "recording")).toBe("[QUARANTINED]");

    await vault.releasePublishedBarrier(receipt.captureId);
    expect(authority.hasActiveBarrier).toBe(false);
    expect(authority.sanitize("Authenticated resource page", "agent_observation")).toBe(
      "Authenticated resource page",
    );
    await vault.releasePublishedBarrier(receipt.captureId);
  });

  it("publishes nothing and retains encrypted evidence when a proposed mapping is incomplete", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "browser-mapping-"));
    const secret = "fixture-secret-881277";
    const vault = await new ProtectedCaptureVault({
      directory,
      runId: RUN_ID,
      scopeId: "fixture-scope",
      authority: protectionAuthority({}, [publicGrant("clientId", ["data", "clientId"])]),
    }).initialize();
    const receipt = await capture(vault, {
      effectId: "00000000-0000-4000-8000-000000000104",
      method: "POST",
      url: "https://fixture.example/credentials",
      status: 201,
      contentType: "application/json",
      body: Buffer.from(JSON.stringify({ data: { clientId: "client-2", clientSecret: secret } })),
    });
    await expect(
      vault.publish(receipt.captureId, [
        {
          key: "clientId",
          semantic: "clientId",
          path: ["data", "clientId"],
          classification: "public",
        },
        { key: "clientSecret", path: ["data", "missingSecret"], classification: "protected" },
      ]),
    ).rejects.toThrow(/capture_output_mapping_incomplete/);
    expect((await vault.receipt(receipt.captureId)).phase).toBe("captured");
    expect(await allFileText(directory)).not.toContain(secret);
  });

  it("rejects ciphertext tampering before interpretation", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "browser-tamper-"));
    const vault = await new ProtectedCaptureVault({
      directory,
      runId: RUN_ID,
      scopeId: "fixture-scope",
      authority: protectionAuthority(),
    }).initialize();
    const receipt = await capture(vault, {
      effectId: "00000000-0000-4000-8000-000000000105",
      method: "POST",
      url: "https://fixture.example/items",
      status: 201,
      contentType: "application/json",
      body: Buffer.from(JSON.stringify({ id: "item-1" })),
    });
    const rawPath = path.join(directory, "captures", `${receipt.captureId}.raw.json`);
    const raw = JSON.parse(await readFile(rawPath, "utf8")) as { ciphertext: string };
    const ciphertext = Buffer.from(raw.ciphertext, "base64");
    ciphertext[0] = (ciphertext[0] ?? 0) ^ 0xff;
    raw.ciphertext = ciphertext.toString("base64");
    await writeFile(rawPath, JSON.stringify(raw));
    await expect(
      vault.publish(receipt.captureId, [
        { key: "id", semantic: "id", path: ["id"], classification: "public" },
      ]),
    ).rejects.toThrow(/encrypted_record_digest_invalid/);
    expect((await vault.receipt(receipt.captureId)).phase).toBe("corrupt");
  });

  it("expires raw captures and removes their ciphertext on cleanup", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "browser-expiry-"));
    const vault = await new ProtectedCaptureVault({
      directory,
      runId: RUN_ID,
      scopeId: "fixture-scope",
      authority: protectionAuthority(),
      retentionMs: 1_000,
    }).initialize();
    const capturedAt = new Date("2026-01-01T00:00:00.000Z");
    const receipt = await capture(vault, {
      effectId: "00000000-0000-4000-8000-000000000106",
      method: "POST",
      url: "https://fixture.example/items",
      status: 201,
      contentType: "application/json",
      body: Buffer.from(JSON.stringify({ id: "item-expired" })),
      capturedAt,
    });
    expect(await vault.deleteExpired(new Date(capturedAt.getTime() + 1_001))).toBe(1);
    expect((await vault.receipt(receipt.captureId)).phase).toBe("expired");
    await expect(
      readFile(path.join(directory, "captures", `${receipt.captureId}.raw.json`)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});

class FakeBrowser extends EventEmitter {
  connected = true;
  isConnected(): boolean {
    return this.connected;
  }
  async close(): Promise<void> {
    this.connected = false;
    this.emit("disconnected");
  }
}

class FakeContext extends EventEmitter {
  async close(): Promise<void> {
    this.emit("close");
  }
}

describe("browser owner recovery", () => {
  it("fences concurrent creation and advances generation after context loss", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "browser-owner-"));
    let contexts = 0;
    const supervisor = await new BrowserOwnerSupervisor({
      directory,
      launchBrowser: async () => new FakeBrowser(),
      createContext: async () => {
        contexts += 1;
        return new FakeContext();
      },
      prepareContext: async () => undefined,
    }).initialize();
    const [first, same] = await Promise.all([supervisor.getContext(), supervisor.getContext()]);
    expect(first).toBe(same);
    expect(contexts).toBe(1);
    first.emit("close");
    const replacement = await supervisor.getContext();
    expect(replacement).not.toBe(first);
    expect(supervisor.status()).toMatchObject({ generation: 2, active: true, losses: 1 });
    await supervisor.close();
  });
});

describe("authenticated evidence", () => {
  it("resumes an authenticated chain across restart and detects ciphertext tampering", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "browser-evidence-"));
    const encryptionKey = randomBytes(32);
    const first = await new AuthenticatedEvidenceStore<{ phase: string }>({
      directory,
      runId: RUN_ID,
      scopeId: "fixture-scope",
      encryptionKey,
      maxChunkBytes: 1_024,
    }).initialize();
    await first.append({ phase: "before-restart" });
    await first.flush();

    const resumed = await new AuthenticatedEvidenceStore<{ phase: string }>({
      directory,
      runId: RUN_ID,
      scopeId: "fixture-scope",
      encryptionKey,
      maxChunkBytes: 1_024,
    }).initialize();
    await resumed.append({ phase: "after-restart" });
    await resumed.flush();
    expect((await resumed.verify()).events).toEqual([
      { phase: "before-restart" },
      { phase: "after-restart" },
    ]);
    expect(await readdir(directory)).not.toContain("evidence.key");

    await expect(
      new AuthenticatedEvidenceStore<{ phase: string }>({
        directory,
        runId: RUN_ID,
        scopeId: "fixture-scope",
        encryptionKey: randomBytes(32),
      }).initialize(),
    ).rejects.toThrow(/evidence_chunk_authentication_invalid/);

    const chunkPath = path.join(directory, "chunk-000001.json");
    const record = JSON.parse(await readFile(chunkPath, "utf8")) as { ciphertext: string };
    const ciphertext = Buffer.from(record.ciphertext, "base64");
    ciphertext[0] = (ciphertext[0] ?? 0) ^ 0xff;
    record.ciphertext = ciphertext.toString("base64");
    await writeFile(chunkPath, JSON.stringify(record));
    await expect(resumed.verify()).rejects.toThrow(/evidence_chunk_digest_invalid/);
  });

  it("fences duplicate continuations and reports interrupted partial writes", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "browser-evidence-contention-"));
    const encryptionKey = randomBytes(32);
    const original = await new AuthenticatedEvidenceStore<{ owner: string }>({
      directory,
      runId: RUN_ID,
      scopeId: "fixture-scope",
      encryptionKey,
      maxChunkBytes: 1_024,
    }).initialize();
    await original.append({ owner: "original" });
    await original.flush();
    const ownerA = await new AuthenticatedEvidenceStore<{ owner: string }>({
      directory,
      runId: RUN_ID,
      scopeId: "fixture-scope",
      encryptionKey,
    }).initialize();
    const ownerB = await new AuthenticatedEvidenceStore<{ owner: string }>({
      directory,
      runId: RUN_ID,
      scopeId: "fixture-scope",
      encryptionKey,
    }).initialize();
    await ownerA.append({ owner: "a" });
    await ownerB.append({ owner: "b" });
    const attempts = await Promise.allSettled([ownerA.flush(), ownerB.flush()]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(
      attempts.filter(
        (attempt) =>
          attempt.status === "rejected" &&
          /evidence_sequence_conflict/.test(String(attempt.reason)),
      ),
    ).toHaveLength(1);
    await writeFile(path.join(directory, "chunk-000002.json.partial-interrupted"), "{");
    const verified = await ownerA.verify();
    expect(verified.complete).toBe(false);
    expect(verified.gaps).toEqual([
      { type: "partial_chunk", name: "chunk-000002.json.partial-interrupted" },
    ]);
  });
});
