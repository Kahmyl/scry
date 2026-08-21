import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { observeAuthenticatedJsonResource } from "@scry/praxis";
import { randomUUID } from "node:crypto";

import { decryptCredential } from "../access/credential.crypto.js";
import { Database } from "../infrastructure/index.js";
import {
  AdaptiveOperationReconciliationRegistry,
  type UnknownOperationAuthority,
} from "./adaptive-operation-reconciliation.registry.js";
import {
  VitractCredentialResourceEffectAdapter,
  type VitractCredentialRecord,
} from "./vitract-credential-resource-effect.adapter.js";

@Injectable()
export class VitractCredentialResourceEffectProvider implements OnModuleInit, OnModuleDestroy {
  private unregister?: () => void;
  private readonly adapter: VitractCredentialResourceEffectAdapter;

  constructor(
    @Inject(AdaptiveOperationReconciliationRegistry)
    private readonly registry: AdaptiveOperationReconciliationRegistry,
    @Inject(Database) private readonly database: Database,
  ) {
    this.adapter = new VitractCredentialResourceEffectAdapter((input) => this.observe(input));
  }

  onModuleInit() {
    this.unregister = this.registry.register(this.adapter);
  }
  onModuleDestroy() {
    this.unregister?.();
  }

  private async observe(
    input: Readonly<{ resourceScope: string; authority: Readonly<UnknownOperationAuthority> }>,
  ) {
    const protectedAuthenticationFacts = (input.authority.preparationFacts ?? []).filter(
      (fact) =>
        (fact.actionKind === "fill" || fact.actionKind === "authenticate") &&
        fact.protectedReferenceId,
    );
    const email = protectedAuthenticationFacts.filter(
      (fact) =>
        fact.targetPlaceholder === "Enter your email" ||
        fact.targetConcept === "Vitract login email" ||
        fact.targetConcept === "login email",
    );
    const password = protectedAuthenticationFacts.filter(
      (fact) =>
        fact.targetPlaceholder === "Enter your password" ||
        fact.targetConcept === "Vitract login password" ||
        fact.targetConcept === "login password",
    );
    if (email.length !== 1 || password.length !== 1)
      throw new Error("VITRACT_RECONCILIATION_AUTHENTICATION_CONTRACT_UNAVAILABLE");
    const references = [email[0]!.protectedReferenceId!, password[0]!.protectedReferenceId!];
    const rows = await this.database.query<{
      id: string;
      ciphertext: Buffer;
      initializationVector: Buffer;
      authenticationTag: Buffer;
      policy: { allowedOrigins?: string[]; trustedScriptOrigins?: string[] };
    }>(
      `SELECT credential.id::text,credential.ciphertext,
              credential.initialization_vector AS "initializationVector",
              credential.authentication_tag AS "authenticationTag",environment.policy
         FROM environments environment
         JOIN project_credentials credential ON credential.project_id=environment.project_id
        WHERE environment.id=$1 AND environment.project_id=$2
          AND credential.id=ANY($3::uuid[]) AND environment.secret_refs ? credential.id::text
          AND credential.security_status='active' AND credential.deleted_at IS NULL`,
      [input.authority.environmentId, input.authority.projectId, references],
    );
    if (rows.rows.length !== 2) throw new Error("VITRACT_RECONCILIATION_CREDENTIALS_UNAVAILABLE");
    const byId = new Map(rows.rows.map((row) => [row.id, row]));
    let emailValue = decryptCredential(byId.get(references[0]!)!);
    let passwordValue = decryptCredential(byId.get(references[1]!)!);
    const policy = rows.rows[0]!.policy;
    try {
      const observation = await observeAuthenticatedJsonResource({
        browserChannel: process.env.SCRY_BROWSER_CHANNEL ?? "chrome",
        allowedOrigins: policy.allowedOrigins ?? [],
        trustedScriptOrigins: policy.trustedScriptOrigins ?? [],
        login: {
          url: "https://preview.vitract.com/login",
          fields: [
            { placeholder: "Enter your email", value: emailValue },
            { placeholder: "Enter your password", value: passwordValue },
          ],
          submitName: "Login",
        },
        resource: {
          url: `https://preview.vitract.com/partner/developer/applications/${encodeURIComponent(input.resourceScope)}/credentials`,
          readiness: { role: "button", name: "Add credential" },
          responseOrigins: ["https://preview.vitract.com", "https://preview-api.vitract.com"],
          responsePath: `/api/v1/partners/applications/${encodeURIComponent(input.resourceScope)}/credentials`,
        },
        timeoutMs: 30_000,
      });
      const records = observation.bodies.flatMap(providerRecords);
      if (observation.bodies.length === 0)
        throw new Error("VITRACT_AUTHORITATIVE_RESOURCE_RESPONSE_UNAVAILABLE");
      const unique = new Map(records.map((record) => [record.identity, record]));
      return {
        source: "authoritative_supported_resource_listing" as const,
        observationId: randomUUID(),
        records: [...unique.values()],
      };
    } finally {
      emailValue = "";
      passwordValue = "";
    }
  }
}

function providerRecords(value: unknown): VitractCredentialRecord[] {
  const records: VitractCredentialRecord[] = [];
  const visit = (candidate: unknown) => {
    if (Array.isArray(candidate)) {
      candidate.forEach(visit);
      return;
    }
    if (!candidate || typeof candidate !== "object") return;
    const object = candidate as Record<string, unknown>;
    if (
      typeof object.id === "string" &&
      typeof object.label === "string" &&
      Object.hasOwn(object, "clientId")
    )
      records.push({
        identity: object.id,
        label: object.label,
        state: typeof object.status === "string" ? object.status : "present",
      });
    Object.values(object).forEach(visit);
  };
  visit(value);
  return records;
}
