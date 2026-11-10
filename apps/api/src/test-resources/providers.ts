import { Injectable, Inject } from "@nestjs/common";
import { Database } from "../infrastructure/database.js";
import {
  ProviderHttp,
  resourceError,
  ProviderDeferred,
  notePartialRefresh,
} from "./provider-http.js";

export type PrivateResource = {
  password?: string;
  address?: string;
  accountId?: string;
  connectionId?: string;
  sourceId?: string;
};
export type ReceivedTestMessage = {
  id: string;
  receivedAt: string;
  title: string;
  content: unknown;
};

@Injectable()
export class TestResourceProviders {
  readonly mail: ProviderHttp;
  readonly hookdeck: ProviderHttp;
  constructor(@Inject(Database) database: Database) {
    this.mail = new ProviderHttp(database, "mail_tm", "https://api.mail.tm");
    this.hookdeck = new ProviderHttp(database, "hookdeck", "https://api.hookdeck.com/2026-09-01");
  }

  capabilities() {
    return {
      mailbox: process.env.SCRY_TEST_MAIL_ENABLED === "true",
      webhook: Boolean(process.env.HOOKDECK_API_KEY),
    };
  }

  async prepareMail(id: string): Promise<string> {
    const { data } = await this.mail.request("/domains");
    const domain = data["hydra:member"]?.find(
      (d: any) => d.isActive && !d.isPrivate && /^[a-z0-9.-]+$/i.test(d.domain),
    );
    if (!domain) resourceError("TEST_MAIL_DOMAIN_UNAVAILABLE");
    return `scry-${id.replaceAll("-", "")}@${domain.domain}`;
  }

  private async mailToken(state: PrivateResource) {
    const { data } = await this.mail.request("/token", {
      method: "POST",
      body: JSON.stringify({ address: state.address, password: state.password }),
    });
    if (typeof data.token !== "string" || typeof data.id !== "string")
      resourceError("TEST_PROVIDER_RESPONSE_INVALID");
    return { token: data.token as string, id: data.id as string };
  }
  private hookAuth() {
    const key = process.env.HOOKDECK_API_KEY;
    if (!key) resourceError("TEST_HOOKDECK_NOT_CONFIGURED");
    return { authorization: `Bearer ${key}` };
  }
  async connectMailbox(state: PrivateResource) {
    const auth = await this.mailToken(state);
    const { data } = await this.mail.request("/me", {
      headers: { authorization: `Bearer ${auth.token}` },
    });
    if (
      data.id !== auth.id ||
      typeof data.address !== "string" ||
      data.address.toLowerCase() !== state.address?.toLowerCase() ||
      data.isDeleted ||
      data.isDisabled
    )
      resourceError("TEST_MAIL_ACCOUNT_UNAVAILABLE", 400);
    return {
      address: state.address!,
      privateData: { address: state.address!, accountId: auth.id },
    };
  }

  async provision(kind: string, id: string, state: PrivateResource) {
    if (kind === "mailbox") {
      await this.mail.request(
        "/accounts",
        {
          method: "POST",
          body: JSON.stringify({ address: state.address, password: state.password }),
        },
        [422],
      );
      // A duplicate address is only adopted if our persisted password works.
      const auth = await this.mailToken(state);
      return { address: state.address!, privateData: { ...state, accountId: auth.id } };
    }
    const name = `scry-${id}`;
    const { data } = await this.hookdeck.request("/connections", {
      method: "PUT",
      headers: this.hookAuth(),
      body: JSON.stringify({
        name,
        source: { name, type: "WEBHOOK" },
        destination: { name, type: "MOCK_API" },
      }),
    });
    if (
      typeof data.id !== "string" ||
      typeof data.source?.id !== "string" ||
      typeof data.source?.url !== "string"
    )
      resourceError("TEST_PROVIDER_RESPONSE_INVALID");
    const address = new URL(data.source.url);
    if (
      address.protocol !== "https:" ||
      address.hostname !== "hkdk.events" ||
      address.username ||
      address.password
    )
      resourceError("TEST_PROVIDER_RESPONSE_INVALID");
    return {
      address: address.href,
      privateData: { connectionId: data.id, sourceId: data.source.id } as PrivateResource,
    };
  }

  async messages(
    kind: string,
    state: PrivateResource,
    known: Set<string>,
  ): Promise<ReceivedTestMessage[]> {
    const result: ReceivedTestMessage[] = [];
    try {
      if (kind === "mailbox") {
        const auth = await this.mailToken(state);
        for (let page = 1; page <= 7; page++) {
          const { data } = await this.mail.request(`/messages?page=${page}`, {
            headers: { authorization: `Bearer ${auth.token}` },
          });
          if (!Array.isArray(data["hydra:member"])) resourceError("TEST_PROVIDER_RESPONSE_INVALID");
          for (const item of data["hydra:member"]) {
            if (known.has(item.id)) continue;
            const message = (
              await this.mail.request(`/messages/${encodeURIComponent(item.id)}`, {
                headers: { authorization: `Bearer ${auth.token}` },
              })
            ).data;
            // JSON-LD represents the account relationship as a relative IRI;
            // ordinary JSON may return the bare ID. Match only these exact
            // representations of the authenticated account, never an arbitrary
            // URL or a suffix extracted from a foreign provider response.
            if (
              message.accountId !== auth.id &&
              message.accountId !== `/accounts/${encodeURIComponent(auth.id)}`
            )
              resourceError("TEST_PROVIDER_SCOPE_INVALID");
            result.push({
              id: message.id,
              receivedAt: message.createdAt,
              title: String(message.subject ?? "Email received"),
              content: {
                from: message.from,
                to: message.to,
                subject: message.subject,
                text: message.text ?? "",
                html: message.html ?? [],
                hasAttachments: Boolean(message.hasAttachments),
              },
            });
            // Commit bounded progress before another call budget is needed.
            if (result.length >= 20) return result;
          }
          if (!data["hydra:view"]?.["hydra:next"]) return result;
        }
        resourceError("TEST_MESSAGE_CAPACITY", 409);
      }
      const { data } = await this.hookdeck.request(
        `/requests?source_id=${encodeURIComponent(state.sourceId!)}&limit=100`,
        { headers: this.hookAuth() },
      );
      if (!Array.isArray(data.models) || Number(data.count) > 100)
        resourceError("TEST_MESSAGE_CAPACITY", 409);
      for (const item of data.models) {
        if (item.source_id !== state.sourceId) resourceError("TEST_PROVIDER_SCOPE_INVALID");
        if (known.has(item.id)) continue;
        const request = (
          await this.hookdeck.request(`/requests/${encodeURIComponent(item.id)}`, {
            headers: this.hookAuth(),
          })
        ).data;
        if (request.source_id !== state.sourceId || request.data?.is_large_payload)
          resourceError("TEST_PROVIDER_RESPONSE_INVALID");
        result.push({
          id: request.id,
          receivedAt: request.ingested_at,
          title: "Webhook received",
          content: {
            ...request.data,
            senderVerified: request.verified === true,
            rejectionCause: request.rejection_cause ?? null,
          },
        });
        if (result.length >= 20) return result;
      }
      return result;
    } catch (error) {
      if (error instanceof ProviderDeferred && result.length) {
        notePartialRefresh();
        return result;
      }
      throw error;
    }
  }

  async close(kind: string, state: PrivateResource) {
    if (kind === "mailbox") {
      if (!state.address) return;
      // DELETE is idempotent. A missing account is already closed; do not
      // recreate a mailbox simply to clean it up.
      let auth: { token: string; id: string };
      try {
        auth = await this.mailToken(state);
      } catch (e) {
        throw e;
      }
      await this.mail.request(
        `/accounts/${encodeURIComponent(auth.id)}`,
        { method: "DELETE", headers: { authorization: `Bearer ${auth.token}` } },
        [404],
      );
    } else if (state.sourceId) {
      await this.hookdeck.request(
        `/sources/${encodeURIComponent(state.sourceId)}/disable`,
        { method: "PUT", headers: this.hookAuth() },
        [404],
      );
    }
  }
}
