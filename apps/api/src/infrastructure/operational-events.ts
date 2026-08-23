import { Injectable } from "@nestjs/common";
import {
  OperationalEventEmitter,
  type OperationalComponent,
  type OperationalEventInput,
} from "@scry/observability";

@Injectable()
export class OperationalEvents {
  private readonly emitters = new Map<OperationalComponent, OperationalEventEmitter>();

  emit(component: OperationalComponent, input: OperationalEventInput) {
    let emitter = this.emitters.get(component);
    if (!emitter) {
      emitter = new OperationalEventEmitter({
        component,
        ...(process.env.SCRY_RELEASE_ID ? { releaseId: process.env.SCRY_RELEASE_ID } : {}),
        ...(process.env.SCRY_SCHEMA_FINGERPRINT
          ? { schemaFingerprint: process.env.SCRY_SCHEMA_FINGERPRINT }
          : {}),
      });
      this.emitters.set(component, emitter);
    }
    return emitter.emit(input);
  }
}

export type ApiOperationalEventWriter = Pick<OperationalEvents, "emit">;

export function installApiRequestObservability(
  server: {
    addHook(
      name: "onResponse",
      hook: (
        request: {
          method: string;
          headers: Record<string, string | string[] | undefined>;
          routeOptions?: { url?: string };
        },
        reply: { statusCode: number },
      ) => Promise<void>,
    ): void;
  },
  events: ApiOperationalEventWriter,
) {
  server.addHook("onResponse", async (request, reply) => {
    if (reply.statusCode < 400) return;
    const status = reply.statusCode;
    await events.emit("api", {
      name: "api.request_rejected",
      classification:
        status >= 500
          ? "infrastructure"
          : status === 401 || status === 403
            ? "policy_refusal"
            : status === 409
              ? "application_provider"
              : "validation",
      reasonCode: `API_REQUEST_REJECTED_${status}`,
      outcome: "refused",
      causality: {
        ...(firstHeader(request.headers["x-correlation-id"])
          ? { correlationId: firstHeader(request.headers["x-correlation-id"])! }
          : {}),
      },
      details: {
        method: request.method,
        route: request.routeOptions?.url ?? "unmatched",
        status,
      },
    });
  });
}

function firstHeader(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}
