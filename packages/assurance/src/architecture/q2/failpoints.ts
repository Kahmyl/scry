import { createHash } from "node:crypto";

import type { Q2FailpointDefinition, Q2FailpointLedgerEntry, Q2SafeScope } from "./types.js";

const approvedCapability = Symbol("q2-approved-test-composition");
type ApprovedCapability = typeof approvedCapability;

export class Q2InjectedFault extends Error {
  constructor(
    readonly definition: Q2FailpointDefinition,
    readonly ledgerRef: string,
  ) {
    super(`Q2_INJECTED_FAULT:${definition.boundary}:${definition.name}:${definition.effect}`);
    this.name = "Q2InjectedFault";
  }
}

export class FailpointController {
  readonly #definitions: ReadonlyMap<string, Q2FailpointDefinition>;
  readonly #invocations = new Map<string, number>();
  readonly #fires = new Map<string, number>();
  readonly #ledger: Q2FailpointLedgerEntry[] = [];

  private constructor(
    capability: ApprovedCapability,
    definitions: readonly Q2FailpointDefinition[],
  ) {
    if (capability !== approvedCapability || process.env.NODE_ENV !== "test")
      throw new Error("Q2_FAILPOINT_CONTROLLER_REJECTED_OUTSIDE_APPROVED_TEST_PROCESS");
    this.#definitions = new Map(definitions.map((definition) => [definition.name, definition]));
  }

  static approvedTestComposition(definitions: readonly Q2FailpointDefinition[]) {
    if (process.env.NODE_ENV !== "test")
      throw new Error("Q2_FAILPOINT_CONTROLLER_REJECTED_OUTSIDE_APPROVED_TEST_PROCESS");
    return new FailpointController(approvedCapability, definitions);
  }

  static disabled(): Readonly<{ atBoundary(name: string, scope: Q2SafeScope): void }> {
    return { atBoundary: () => undefined };
  }

  atBoundary(name: string, scope: Q2SafeScope): void {
    assertSafeScope(scope);
    const definition = this.#definitions.get(name);
    if (!definition) return;
    const invocation = (this.#invocations.get(name) ?? 0) + 1;
    this.#invocations.set(name, invocation);
    const fires = this.#fires.get(name) ?? 0;
    if (invocation < definition.fireOnNth || fires >= definition.maxFires) return;
    const firedAtOrdinal = this.#ledger.length + 1;
    this.#fires.set(name, fires + 1);
    this.#ledger.push({ ...definition, invocation, firedAtOrdinal, scope: { ...scope } });
    const ledgerRef = createHash("sha256")
      .update(`${definition.boundary}:${definition.name}:${invocation}:${scope.correlationId}`)
      .digest("hex");
    throw new Q2InjectedFault(definition, ledgerRef);
  }

  ledger(): readonly Q2FailpointLedgerEntry[] {
    return structuredClone(this.#ledger);
  }
}

function assertSafeScope(scope: Q2SafeScope) {
  for (const [field, value] of Object.entries(scope)) {
    if (!/^[a-z0-9][a-z0-9._:-]{0,127}$/i.test(value))
      throw new Error(`Q2_UNSAFE_FAILPOINT_SCOPE:${field}`);
  }
}
