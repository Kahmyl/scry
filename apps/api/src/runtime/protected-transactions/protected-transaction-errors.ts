import type { ProtectedTransactionResult } from "@scry/contracts";

export class ProtectedTransactionPhaseError extends Error {
  constructor(
    readonly code: string,
    readonly phase: NonNullable<ProtectedTransactionResult["failurePhase"]>,
    readonly retryClass: NonNullable<ProtectedTransactionResult["retryClass"]>,
  ) {
    super(code);
    this.name = "ProtectedTransactionPhaseError";
  }
}
