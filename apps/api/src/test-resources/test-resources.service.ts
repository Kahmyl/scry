import {
  Inject,
  Injectable,
  HttpException,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import type {
  ConnectTestMailboxInput,
  CreateTestResourceInput,
  RefreshTestResourceInput,
} from "@scry/contracts";
import { BrowserCommandRepository } from "../browser-execution/repositories/browser-command.repository.js";
import { TestResourceProviders, type PrivateResource } from "./providers.js";
import { TestResourcesRepository, type ResourceRow } from "./test-resources.repository.js";
import {
  ProviderDeferred,
  resourceError,
  withProviderBudget,
  providerPause,
  providerTiming,
} from "./provider-http.js";
import { createHash } from "node:crypto";
import { verifyRawWebhookHmac } from "@scry/veil";
import { verifyTestWebhookSignatureSchema } from "@scry/contracts";
import type { z } from "zod";

@Injectable()
export class TestResourcesService implements OnModuleInit, OnModuleDestroy {
  async verifySignature(
    workspace: string | undefined,
    resourceId: string,
    input: z.infer<typeof verifyTestWebhookSignatureSchema>,
  ) {
    const { row, event } = await this.repository.signatureContext(
      workspace,
      resourceId,
      input.eventId,
      input.runId,
    );
    const inputDigest = createHash("sha256")
      .update(JSON.stringify({ resourceId, ...input }))
      .digest("hex");
    const prior = await this.repository.signatureReceipt(
      input.runId,
      input.idempotencyKey,
      inputDigest,
    );
    if (prior) return { ...prior, cached: true };
    const secret = await this.commands.protectedValueForBrowser(
      event.session_id,
      input.protectedValueId,
      "hmac_verification",
    );
    try {
      const receipt = await this.providers.webhookSignatureReceipt(
        this.repository.open(row.private_data, row.id),
        event.provider_event_id,
      );
      if (!receipt.available)
        return {
          status: "unavailable",
          reason: "exact_raw_body_unavailable",
          nextAction:
            "Preserve the received event; verify only when its original bytes are available. Do not reconstruct JSON or replay delivery just for this check.",
        };
      const header = (name: string) => {
        const pairs = Object.entries(receipt.headers).filter(
          ([key]) => key.toLowerCase() === name.toLowerCase(),
        );
        return pairs.length === 1 && typeof pairs[0]![1] === "string"
          ? (pairs[0]![1] as string)
          : undefined;
      };
      const signature = header(input.signatureHeader),
        timestamp = input.timestampHeader ? header(input.timestampHeader) : undefined;
      if (signature === undefined || (input.timestampHeader && timestamp === undefined))
        return {
          status: "unavailable",
          reason: "signature_headers_missing_or_ambiguous",
          nextAction:
            "Check the application's documented signature header and signing recipe for this same received event.",
        };
      const matched = verifyRawWebhookHmac(
        secret,
        receipt.body,
        signature,
        input.encoding,
        input.prefix,
        timestamp,
      );
      return this.repository.saveSignatureReceipt(
        input.eventId,
        input.runId,
        input.protectedValueId,
        input.idempotencyKey,
        inputDigest,
        {
          status: matched ? "matched" : "different",
          algorithm: "hmac_sha256",
          signedData: timestamp === undefined ? "exact_raw_body" : "timestamp_dot_exact_raw_body",
          encoding: input.encoding,
          bodyBytes: receipt.body.length,
          eventId: input.eventId,
          runId: input.runId,
          protectedValueId: input.protectedValueId,
          verifiedAt: new Date().toISOString(),
          replayProtection: "not_assessed",
          cached: false,
        },
      );
    } catch (error) {
      if (!(error instanceof ProviderDeferred)) throw error;
      return {
        status: "temporarily_unavailable",
        retryAfterSeconds: error.retryAfterSeconds,
        nextAction:
          "Retry this same signature check and event after the provider delay. Do not resend the event.",
      };
    }
  }
  private timer?: ReturnType<typeof setInterval>;
  private sweeping = false;
  constructor(
    @Inject(TestResourcesRepository) readonly repository: TestResourcesRepository,
    @Inject(TestResourceProviders) readonly providers: TestResourceProviders,
    @Inject(BrowserCommandRepository) readonly commands: BrowserCommandRepository,
  ) {}
  onModuleInit() {
    this.timer = setInterval(() => {
      void this.expire();
    }, 60000);
    this.timer.unref();
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }
  async list(workspace: string | undefined, mission: string) {
    const scope = await this.repository.requireMission(workspace, mission);
    return {
      resources: await this.repository.list(workspace, mission),
      capabilities: this.providers.capabilities(),
      credentials: await this.commands.listProtectedInputs(workspace, scope.projectId),
    };
  }
  async connect(workspace: string | undefined, mission: string, input: ConnectTestMailboxInput) {
    const { address, passwordCredentialId, ...allocation } = input;
    return this.create(
      workspace,
      mission,
      { ...allocation, kind: "mailbox" },
      { address, passwordCredentialId },
    );
  }
  private async providerState(row: ResourceRow): Promise<PrivateResource> {
    const state = this.repository.open<PrivateResource>(row.private_data, row.id);
    return row.ownership === "customer"
      ? {
          ...state,
          address: row.connected_address!,
          password: await this.repository.mailboxPassword(
            row.projectId,
            row.password_credential_id!,
          ),
        }
      : state;
  }
  async create(
    workspace: string | undefined,
    mission: string,
    input: CreateTestResourceInput,
    connection?: { address: string; passwordCredentialId: string },
  ) {
    await this.repository.requireMission(workspace, mission);
    if (!this.providers.capabilities()[input.kind])
      resourceError(
        input.kind === "mailbox" ? "TEST_MAIL_NOT_CONFIGURED" : "TEST_HOOKDECK_NOT_CONFIGURED",
      );
    const row = await this.repository.allocate(workspace, mission, input, connection);
    if (new Date(row.expiresAt).getTime() <= Date.now()) return this.close(workspace, row.id);
    if (row.state !== "pending") return this.repository.public(row);
    const lease = await this.repository.claim(row);
    if (!lease)
      return {
        ...this.repository.public(await this.repository.resource(workspace, row.id)),
        retryAfterSeconds: 2,
        availability: "waiting",
      };
    try {
      let state = await this.providerState(row);
      if (row.ownership === "scry" && row.kind === "mailbox" && !state.address) {
        state = { ...state, address: await this.providers.prepareMail(row.id) };
        // Persist the exact account identity BEFORE any external creation.
        await this.repository.savePrivate(row.id, lease, state);
      }
      const result =
        row.ownership === "customer"
          ? await this.providers.connectMailbox(state)
          : await this.providers.provision(row.kind, row.id, state);
      await this.repository.ready(row.id, lease, result.address, result.privateData);
    } catch (error) {
      if (!(error instanceof ProviderDeferred)) throw error;
      return {
        ...this.repository.public(await this.repository.resource(workspace, row.id)),
        retryAfterSeconds: error.retryAfterSeconds,
        availability: error.reason === "rate_limit" ? "waiting" : "temporarily_unavailable",
      };
    } finally {
      await this.repository.release(row.id, lease);
    }
    return this.repository.public(await this.repository.resource(workspace, row.id));
  }
  async read(workspace: string | undefined, id: string, input: RefreshTestResourceInput) {
    const started = Date.now();
    const budgetMs = Math.min(20000, input.waitSeconds * 1000 + 5000);
    const { result, timing } = await withProviderBudget(async () => {
      try {
        return {
          result: await this.readWithinBudget(workspace, id, input),
          timing: providerTiming(),
        };
      } catch (error) {
        if (error instanceof ProviderDeferred)
          throw new HttpException(
            {
              code: "TEST_RESOURCE_METADATA_UNAVAILABLE",
              status: 503,
              message:
                "Resource facts could not be loaded in time. Saved observations are unchanged; retry the same resource.",
              retryAfterSeconds: error.retryAfterSeconds,
            },
            503,
          );
        throw error;
      }
    }, budgetMs);
    return {
      ...result,
      timing: {
        elapsedMs: Date.now() - started,
        refreshRequested: input.refresh !== false,
        providerBudgetMs: input.refresh === false ? 0 : budgetMs,
        serverBudgetMs: budgetMs + 1000,
        ...timing,
      },
    };
  }
  private async readWithinBudget(
    workspace: string | undefined,
    id: string,
    input: RefreshTestResourceInput,
  ) {
    const row = await this.repository.resource(workspace, id);
    if (
      input.afterEventId &&
      !(await this.repository.events(workspace, id)).some((e) => e.id === input.afterEventId)
    )
      resourceError("TEST_EVENT_CURSOR_INVALID", 400);
    if (input.refresh === false) {
      const events = await this.repository.events(workspace, id);
      return {
        resource: this.repository.public(row),
        events,
        status: (
          input.afterEventId
            ? events.findIndex((e) => e.id === input.afterEventId) < events.length - 1
            : events.length > 0
        )
          ? ("received" as const)
          : ("waiting" as const),
        cached: true,
      };
    }
    if (row.state !== "ready" || new Date(row.expiresAt).getTime() <= Date.now())
      return {
        resource: this.repository.public(row),
        events: await this.repository.events(workspace, id),
        status: row.state === "pending" ? ("waiting" as const) : ("closed" as const),
      };
    const lease = await this.repository.claim(row);
    if (!lease)
      return {
        resource: this.repository.public(await this.repository.resource(workspace, id)),
        events: await this.repository.events(workspace, id),
        status: "waiting" as const,
        retryAfterSeconds: 2,
      };
    const deadline = Date.now() + input.waitSeconds * 1000;
    try {
      const baseline = await this.repository.known(id);
      do {
        const messages = await this.providers.messages(
          row.kind,
          await this.providerState(row),
          await this.repository.known(id),
        );
        await this.repository.record(row, lease, messages);
        const events = await this.repository.events(workspace, id);
        if (
          events.length > baseline.size ||
          (input.afterEventId
            ? events.findIndex((e) => e.id === input.afterEventId) < events.length - 1
            : events.length > 0)
        )
          return { resource: this.repository.public(row), events, status: "received" as const };
        if (Date.now() >= deadline) break;
        await providerPause(Math.min(1500, Math.max(0, deadline - Date.now())), "polling");
      } while (Date.now() < deadline);
      return {
        resource: this.repository.public(row),
        events: await this.repository.events(workspace, id),
        status: "waiting" as const,
      };
    } catch (error) {
      if (!(error instanceof ProviderDeferred)) throw error;
      return {
        resource: this.repository.public(row),
        events: await this.repository.events(workspace, id),
        status: "waiting" as const,
        retryAfterSeconds: error.retryAfterSeconds,
        availability: error.reason === "rate_limit" ? "waiting" : "temporarily_unavailable",
      };
    } finally {
      await this.repository.release(id, lease);
    }
  }
  async close(workspace: string | undefined, id: string) {
    const row = await this.repository.resource(workspace, id);
    if (row.state === "closed") return this.repository.public(row);
    const lease = await this.repository.claim(row, true);
    if (!lease)
      return {
        ...this.repository.public(await this.repository.resource(workspace, id)),
        retryAfterSeconds: 2,
        availability: "waiting",
      };
    try {
      // All closure paths disconnect customer mailboxes locally, including
      // expiry and recovery. No provider create/delete operation is permitted.
      if (row.ownership === "customer") {
        await this.repository.markClosed(id, lease);
        return this.repository.public(await this.repository.resource(workspace, id));
      }
      let state = this.repository.open<PrivateResource>(row.private_data, id);
      // Recover a creation whose response was lost using the SAME identity.
      // Never allocate another mailbox/listener during close.
      if (row.state === "pending" && (state.address || row.kind === "webhook")) {
        state = (await this.providers.provision(row.kind, id, state)).privateData;
        await this.repository.savePrivate(id, lease, state);
      }
      await this.providers.close(row.kind, state);
      await this.repository.markClosed(id, lease);
    } catch (error) {
      if (!(error instanceof ProviderDeferred)) throw error;
      return {
        ...this.repository.public(await this.repository.resource(workspace, id)),
        retryAfterSeconds: error.retryAfterSeconds,
        availability: "waiting",
      };
    } finally {
      await this.repository.release(id, lease);
    }
    return this.repository.public(await this.repository.resource(workspace, id));
  }
  async useSecret(workspace: string | undefined, resource: string, run: string, value: string) {
    await this.repository.authorizeSecret(workspace, resource, run, value);
    return this.commands.bindProtectedInputs(workspace, run, [value]);
  }
  private async expire() {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const rows = await this.repository.expiredForCleanup();
      for (const row of rows)
        await withProviderBudget(() => this.close(undefined, row.id)).catch(() => {
          /* Durable closing state remains retryable. No provider details in logs. */
        });
    } catch {
      /* Database readiness is monitored independently. */
    } finally {
      this.sweeping = false;
    }
  }
}
