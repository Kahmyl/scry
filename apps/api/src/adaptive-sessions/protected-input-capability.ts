export type ProtectedInputDeliveryBinding = Readonly<{
  sessionId: string;
  operationId: string;
  protectedReferenceId: string;
  targetReference: string;
}>;

export class ProtectedInputDeliveryError extends Error {
  readonly code = "PROTECTED_INPUT_DELIVERY_BINDING_MISMATCH";

  constructor() {
    super("Protected input delivery binding mismatch");
    this.name = "ProtectedInputDeliveryError";
  }
}

/**
 * Opaque, operation-scoped delivery capability. Plaintext exists only inside
 * the resolver invocation consumed by the bound Executor/Praxis operation.
 */
export function bindProtectedInputDelivery(
  binding: ProtectedInputDeliveryBinding,
  resolve: () => Promise<string>,
) {
  const expected = Object.freeze({ ...binding });
  return Object.freeze({
    async consume(actual: ProtectedInputDeliveryBinding) {
      if (
        actual.sessionId !== expected.sessionId ||
        actual.operationId !== expected.operationId ||
        actual.protectedReferenceId !== expected.protectedReferenceId ||
        actual.targetReference !== expected.targetReference
      ) {
        throw new ProtectedInputDeliveryError();
      }
      return resolve();
    },
  });
}
