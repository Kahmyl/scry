import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import type {
  ConnectTestMailboxInput,
  CreateTestResourceInput,
  RefreshTestResourceInput,
} from "@scry/contracts";
import { BrowserCommandRepository } from "../browser-execution/repositories/browser-command.repository.js";
import { TestResourceProviders, type PrivateResource } from "./providers.js";
import { TestResourcesRepository, type ResourceRow } from "./test-resources.repository.js";
import { ProviderDeferred, resourceError, withProviderBudget } from "./provider-http.js";

@Injectable()
export class TestResourcesService implements OnModuleInit, OnModuleDestroy {
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
    const row = await this.repository.resource(workspace, id);
    if (
      input.afterEventId &&
      !(await this.repository.events(workspace, id)).some((e) => e.id === input.afterEventId)
    )
      resourceError("TEST_EVENT_CURSOR_INVALID", 400);
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
    const baseline = await this.repository.known(id);
    const deadline = Date.now() + input.waitSeconds * 1000;
    try {
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
        await new Promise((resolve) => setTimeout(resolve, 1500));
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
        await this.repository.db.query(
          "UPDATE test_resources SET state='closed',address=NULL WHERE id=$1 AND lease_id=$2 AND lease_until>now()",
          [id, lease],
        );
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
      await this.repository.db.query(
        "UPDATE test_resources SET state='closed',address=NULL WHERE id=$1 AND lease_id=$2 AND lease_until>now()",
        [id, lease],
      );
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
      const rows = await this.repository.db.query<{ id: string }>(
        "SELECT id FROM test_resources WHERE expires_at<now() AND state<>'closed' AND (lease_until IS NULL OR lease_until<now()) ORDER BY expires_at LIMIT 10",
      );
      for (const row of rows.rows)
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
