import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ScryApiClient } from "../src/api-client.js";
import { createScryMcpServer } from "../src/server.js";

const ids = {
  project: "10000000-0000-4000-8000-000000000001",
  environment: "10000000-0000-4000-8000-000000000002",
  mission: "10000000-0000-4000-8000-000000000003",
  objective: "10000000-0000-4000-8000-000000000004",
  agent: "10000000-0000-4000-8000-000000000005",
  praxis: "10000000-0000-4000-8000-000000000006",
  issueContract: "10000000-0000-4000-8000-000000000007",
  authContract: "10000000-0000-4000-8000-000000000008",
  createContract: "10000000-0000-4000-8000-000000000009",
  retrieveContract: "10000000-0000-4000-8000-00000000000a",
  issueOperation: "10000000-0000-4000-8000-00000000000b",
  authOperation: "10000000-0000-4000-8000-00000000000c",
  createOperation: "10000000-0000-4000-8000-00000000000d",
  retrieveOperation: "10000000-0000-4000-8000-00000000000e",
  checkpoint: "10000000-0000-4000-8000-00000000000f",
  orderValue: "10000000-0000-4000-8000-000000000010",
};
const digest = (character: string) => character.repeat(64);
const control = (character: string) => `context-control-${character.repeat(32)}`;
const expiresAt = "2099-08-30T12:00:00.000Z";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("prepared protected production journey", () => {
  it("round-trips the thin operation and continuation protocol over simulated API responses", async () => {
    vi.stubEnv("SCRY_LEGACY_MCP_FIXTURES", "");
    const state = {
      authenticated: false,
      businessCreates: 0,
      sourceDispatched: false,
      continuationClaimed: false,
      retrieved: false,
    };
    const contracts = {
      issue: contract(
        ids.issueContract,
        digest("1"),
        "issueCredentials",
        "POST",
        "/credentials",
        "mutation",
        control("1"),
        [],
        ["clientId", "clientSecret"],
        "none",
      ),
      auth: contract(
        ids.authContract,
        digest("2"),
        "authenticate",
        "POST",
        "/sessions",
        "mutation",
        control("2"),
        [
          field("clientId", "generated_safe", control("3")),
          field("clientSecret", "protected", control("4")),
        ],
        ["authenticated"],
        "none",
      ),
      create: contract(
        ids.createContract,
        digest("3"),
        "createOrder",
        "POST",
        "/orders",
        "mutation",
        control("5"),
        [field("clientId", "public", control("6"))],
        ["orderId"],
        "read_only_retrieve",
        "$.orderId",
        { canonicalTargetFieldKey: "orderId", pathTemplate: "/orders/{orderId}" },
      ),
      retrieve: contract(
        ids.retrieveContract,
        digest("4"),
        "retrieveOrder",
        "GET",
        "/orders/{orderId}",
        "read_only",
        control("7"),
        [field("orderId", "generated_safe", control("8"))],
        ["orderId"],
        "none",
        "$.orderId",
      ),
    };

    vi.stubGlobal(
      "fetch",
      vi.fn(async (request: string | URL | Request, init?: RequestInit) => {
        const url = new URL(
          typeof request === "string" || request instanceof URL ? request : request.url,
        );
        const path = url.pathname.replace(/^\/api/, "");
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        if (path === `/praxis-sessions/${ids.praxis}/runtime-ownership`)
          return json({ sessionState: "active", runtime: { state: "owned" } });
        if (path === `/praxis-sessions/${ids.praxis}/operation-contracts`)
          return json({
            contracts: state.authenticated
              ? [contracts.create, contracts.retrieve]
              : state.sourceDispatched
                ? [contracts.auth]
                : [contracts.issue],
          });
        if (path.endsWith("/protected-operations/reserve")) {
          if (body.publicOperationId === "retrieve-order") {
            expect(body.continuationReference).toBe(ids.checkpoint);
            expect(body.values).toEqual([]);
            state.continuationClaimed = true;
          }
          return json({
            protectedOperationId: operationFor(body.publicOperationId),
            preparedExecutionCapabilityId: operationFor(body.publicOperationId),
            publicOperationId: body.publicOperationId,
            state: "reserved",
            mutationIdentity: operationFor(body.publicOperationId),
            contractDigest: body.operationContractRevisionDigest,
            expiresAt,
          });
        }
        if (path.endsWith("/protected-operations/dispatch")) {
          if (body.protectedOperationId === ids.issueOperation) state.sourceDispatched = true;
          if (body.protectedOperationId === ids.authOperation) state.authenticated = true;
          if (body.protectedOperationId === ids.createOperation) {
            if (state.businessCreates > 0)
              return json(
                {
                  message: {
                    code: "PROTECTED_OPERATION_REPLAY_REFUSED",
                    mutationOutcome: "applied",
                    retry: "never",
                    safeActions: ["list_mission_continuations"],
                  },
                },
                409,
              );
            state.businessCreates += 1;
          }
          if (body.protectedOperationId === ids.retrieveOperation) state.retrieved = true;
          return json({
            protectedOperationId: body.protectedOperationId,
            publicOperationId: body.publicOperationId,
            state: "dispatching",
            replayed: false,
            sourceMutationRepeatable: false,
          });
        }
        if (path.endsWith("/continuations"))
          return json({
            continuations: state.retrieved
              ? []
              : [
                  {
                    continuationReference: ids.checkpoint,
                    sourceOperationId: ids.createOperation,
                    resourceType: "order",
                    canonicalIdentityReference: ids.orderValue,
                    readOnly: true,
                    description: "Retrieve the created order",
                    eligibleOperations: [],
                  },
                ],
          });
        return json(
          {
            message: {
              code: "NOT_FOUND",
              mutationOutcome: "not_applied",
              retry: "never",
              safeActions: [],
            },
          },
          404,
        );
      }),
    );

    const { client, server } = await connected();
    const call = async (name: string, args: Record<string, unknown>) => {
      const response = await client.callTool({ name, arguments: args });
      expect(
        response.isError,
        `${name}: ${JSON.stringify({ structured: response.structuredContent, content: response.content })}`,
      ).not.toBe(true);
      return response.structuredContent as Record<string, any>;
    };
    expect(
      await call("get_praxis_runtime_ownership", { praxisSessionId: ids.praxis }),
    ).toMatchObject({ ownership: { sessionState: "active", runtime: { state: "owned" } } });

    const issueObservation = await call("observe_operation_contracts", {
      praxisSessionId: ids.praxis,
    });
    expect(issueObservation.observation.contracts[0].revision.facts.operation.key).toBe(
      "issueCredentials",
    );
    await execute(call, contracts.issue, ids.issueOperation, "issue-credentials", []);

    const authObservation = await call("observe_operation_contracts", {
      praxisSessionId: ids.praxis,
    });
    expect(authObservation.observation.contracts[0].revision.facts.operation.key).toBe(
      "authenticate",
    );
    await execute(call, contracts.auth, ids.authOperation, "authenticate", [
      value("clientId", control("3"), "generated_safe", {
        valueAssetId: "30000000-0000-4000-8000-000000000001",
      }),
      value(
        "clientSecret",
        control("4"),
        "generated_protected",
        { valueAssetId: "30000000-0000-4000-8000-000000000002" },
        "protected_text",
      ),
    ]);

    const docs = await call("observe_operation_contracts", { praxisSessionId: ids.praxis });
    expect(
      docs.observation.contracts.map((item: any) => item.revision.facts.operation.key),
    ).toEqual(["createOrder", "retrieveOrder"]);
    await execute(call, contracts.create, ids.createOperation, "create-order", [
      value("clientId", control("6"), "literal_public", { value: "public-client-id" }),
    ]);
    expect(state.businessCreates).toBe(1);

    const beforeRetrieve = await call("list_mission_continuations", {
      praxisSessionId: ids.praxis,
    });
    expect(beforeRetrieve.result.continuations[0]).toMatchObject({
      continuationReference: ids.checkpoint,
      sourceOperationId: ids.createOperation,
      readOnly: true,
    });
    await reserve(
      call,
      contracts.retrieve,
      ids.retrieveOperation,
      "retrieve-order",
      [],
      ids.checkpoint,
    );
    await dispatch(call, contracts.retrieve, ids.retrieveOperation, "retrieve-order", []);
    expect(
      (await call("list_mission_continuations", { praxisSessionId: ids.praxis })).result
        .continuations,
    ).toEqual([]);
    expect(state).toMatchObject({
      authenticated: true,
      businessCreates: 1,
      continuationClaimed: true,
      retrieved: true,
    });
    await client.close();
    await server.close();
  });
});

function contract(
  id: string,
  contractDigest: string,
  key: string,
  method: "GET" | "POST",
  pathTemplate: string,
  classification: "read_only" | "mutation",
  activationControlReference: string,
  inputs: ReturnType<typeof field>[],
  safeOutputKeys: string[],
  continuation: "none" | "read_only_retrieve",
  publicIdentityOutputPath?: string,
  retrieval?: { canonicalTargetFieldKey: string; pathTemplate: string },
) {
  return {
    revision: {
      id,
      revision: 1,
      digest: contractDigest,
      retentionState: "active",
      staleness: "current",
      createdAt: "2026-08-30T12:00:00.000Z",
      provenance: {
        sourceKind: "public_document",
        observationId: `observation-${key}`,
        origin: "https://preview.vitract.test",
        observedAt: "2026-08-30T12:00:00.000Z",
      },
      facts: {
        application: { key: "laboratory", provider: "laboratory" },
        adapter: { key: "public_document", version: 1 },
        operation: {
          key,
          label: key,
          method,
          pathTemplate,
          transports: ["fetch"],
          semantics: {
            dispatch: classification,
            effects: classification === "mutation" ? ["business_effect"] : ["read"],
          },
        },
        inputs: inputs.map(({ controlReference: _controlReference, ...field }) => field),
        auth: { presentationClasses: ["protected_text"] },
        response: {
          statusClasses: [2],
          ...(classification === "mutation"
            ? { mutationPolicy: { confirmedNotAppliedStatuses: [400, 401, 403, 422] } }
            : {}),
          outputs: safeOutputKeys.map((outputKey) => ({
            key: outputKey,
            label: outputKey,
            classification: outputKey === "clientSecret" ? "protected" : "public",
            ...(publicIdentityOutputPath && outputKey === "orderId"
              ? {
                  extractor: { kind: "json_path", path: publicIdentityOutputPath },
                  identityRole: "continuation_identity",
                }
              : {}),
            generatedValueEligible: true,
          })),
          continuation,
        },
        ...(retrieval ? { retrieval } : {}),
      },
    },
    interaction: {
      id,
      operationContractRevisionId: id,
      operationContractRevisionDigest: contractDigest,
      praxisSessionId: ids.praxis,
      documentEpoch: 1,
      origin: "https://preview.vitract.test",
      activationControlReference,
      inputControlReferences: Object.fromEntries(
        inputs.map((input) => [input.key, input.controlReference]),
      ),
      issuedAt: "2026-08-30T12:00:00.000Z",
      expiresAt,
      state: "active",
    },
    executableInteractionAvailable: true,
  };
}
function field(
  key: string,
  classification: "public" | "protected" | "generated_safe",
  controlReference: string,
) {
  return {
    key,
    label: key,
    aliases: [],
    required: true,
    classification,
    acceptedPresentations: classification === "protected" ? ["protected_text"] : ["plain_text"],
    controlReference,
  };
}
function value(
  canonicalFieldKey: string,
  targetReference: string,
  kind: string,
  source: Record<string, unknown>,
  presentationClass = "plain_text",
) {
  return { canonicalFieldKey, targetReference, presentationClass, source: { kind, ...source } };
}
function operationFor(publicOperationId: string) {
  return (
    {
      "issue-credentials": ids.issueOperation,
      authenticate: ids.authOperation,
      "create-order": ids.createOperation,
      "retrieve-order": ids.retrieveOperation,
    } as Record<string, string>
  )[publicOperationId];
}
async function reserve(
  call: (name: string, args: Record<string, unknown>) => Promise<Record<string, any>>,
  observed: ReturnType<typeof contract>,
  protectedOperationId: string,
  publicOperationId: string,
  values: unknown[],
  continuationReference?: string,
) {
  await call("reserve_prepared_protected_operation", {
    projectId: ids.project,
    environmentId: ids.environment,
    missionId: ids.mission,
    objectiveId: ids.objective,
    agentSessionId: ids.agent,
    praxisSessionId: ids.praxis,
    publicOperationId,
    operationContractRevisionId: observed.revision.id,
    operationContractRevisionDigest: observed.revision.digest,
    runtimeInteractionCapabilityId: observed.interaction.id,
    values,
    continuationReference,
    expectedOutputs: observed.revision.facts.response.outputs.map(({ key, classification }) => ({
      key,
      classification,
    })),
    expiresAt,
  });
}
async function dispatch(
  call: (name: string, args: Record<string, unknown>) => Promise<Record<string, any>>,
  observed: ReturnType<typeof contract>,
  protectedOperationId: string,
  publicOperationId: string,
  _values: unknown[],
) {
  const exact = {
    protectedOperationId,
    preparedExecutionCapabilityId: protectedOperationId,
    publicOperationId,
    praxisSessionId: ids.praxis,
  };
  await call("dispatch_prepared_protected_operation", exact);
}
async function execute(
  call: (name: string, args: Record<string, unknown>) => Promise<Record<string, any>>,
  observed: ReturnType<typeof contract>,
  protectedOperationId: string,
  publicOperationId: string,
  values: unknown[],
) {
  await reserve(call, observed, protectedOperationId, publicOperationId, values);
  await dispatch(call, observed, protectedOperationId, publicOperationId, values);
}
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
async function connected() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createScryMcpServer(new ScryApiClient("http://scry.test/api"));
  const client = new Client({ name: "repository-blind-production-journey", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}
