/**
 * Execution-kernel port for protected transactions.
 *
 * The API runtime owns protected transaction orchestration, persistence,
 * recovery, acquisition and reconciliation. Executor owns only the narrow
 * capability boundary required by the execution kernel.
 */
import type { CapsuleFactory } from "@scry/praxis";
import type {
  Assertion,
  ProtectedOperationClaim,
  ProtectedTransaction,
  ProtectedTransactionResult,
  ProtectedTransactionStore,
} from "@scry/contracts";
import type { SecretRedactor } from "@scry/policy";
import type { ProtectedBrowserSession, SafeBrowserSession } from "@scry/praxis";
import type { VeilRuntimeCoordinator } from "@scry/veil";
import type { Page } from "playwright";

export type ProtectedTransactionDependencies = {
  safeSession: SafeBrowserSession;
  gate: VeilRuntimeCoordinator;
  redactor: SecretRedactor;
  store: ProtectedTransactionStore;
  capsuleFactory: CapsuleFactory;
  liveProtectedSession?: ProtectedBrowserSession;
  allowedOrigins: string[];
  persistSecret(input: {
    operationId: string;
    reference: string;
    name: string;
    value: string;
    scope: "run" | "project";
  }): Promise<{ credentialId: string }>;
  persistPublicValue(input: {
    operationId: string;
    reference: string;
    name: string;
    value: string;
    scope: "run" | "project";
  }): Promise<{ valueId: string }>;
  persistOutputsAtomically?(input: {
    operationId: string;
    claim: ProtectedOperationClaim;
    outputs: Array<{
      reference: string;
      classification: "public" | "protected";
      name: string;
      value: string;
      scope: "run" | "project";
    }>;
    externalResourceBindings: ProtectedTransaction["extraction"]["externalResourceBindings"];
  }): Promise<{
    claim: ProtectedOperationClaim;
    references: Record<
      string,
      {
        classification: "public" | "protected";
        credentialId?: string;
        valueId?: string;
        scope: "run" | "project";
      }
    >;
  }>;
  stageResponseOutputsAtomically?(input: {
    operationId: string;
    claim: ProtectedOperationClaim;
    outputs: Array<{
      reference: string;
      classification: "public" | "protected";
      name: string;
      value: string;
      scope: "run" | "project";
    }>;
  }): Promise<void>;
  recoverStagedResponseOutputs?(input: {
    operationId: string;
    claim: ProtectedOperationClaim;
  }): Promise<
    | Array<{
        reference: string;
        classification: "public" | "protected";
        name: string;
        value: string;
        scope: "run" | "project";
      }>
    | undefined
  >;
  resolveKnownSecret(reference: string): Promise<string>;
  verifyAssertions(page: Page, assertions: Assertion[]): Promise<void>;
  prepareCapsule(session: ProtectedBrowserSession): Promise<void>;
  onPreparationVerified?(
    session: ProtectedBrowserSession,
    transaction: ProtectedTransaction,
  ): Promise<void>;
  reconcile?(
    session: SafeBrowserSession,
    transaction: ProtectedTransaction,
  ): Promise<"succeeded" | "not_applied" | "unknown">;
  recreateCleanSession?(checkpointId: string): Promise<SafeBrowserSession>;
  reauthenticate?(authenticationContractId: string): Promise<SafeBrowserSession>;
  onContextProvenance?(input: {
    contextId: string;
    provenance: string;
    operationId: string;
  }): Promise<void>;
  onEvidenceResumed?(input: {
    contextId: string;
    operationId: string;
    continuedAtStepId: string;
  }): Promise<void>;
  emit?(type: string, payload: Record<string, unknown>): Promise<void>;
  recoverAcquisition?(input: {
    operationId: string;
    expiresAt: string;
    permittedActions: string[];
  }): Promise<{
    action: "retry" | "request_secure_assistance" | "revoke" | "abandon" | "expired";
    correctedScope?: import("@scry/contracts").SemanticScope;
  }>;
  signal?: AbortSignal;
  onMutationDispatch?(): void | Promise<void>;
  dispatchDisposition?: "execute" | "qualification_only";
  onReadyToDispatch?(input: {
    operationId: string;
    disposition: "execute" | "qualification_only";
  }): void | Promise<void>;
  markCredentialCompromised?(
    credentialId: string,
    code: string,
    operationId: string,
  ): Promise<void>;
};

export type ProtectedTransactionExecution = {
  result: ProtectedTransactionResult;
  safeSession: SafeBrowserSession;
  terminal: boolean;
};

export type ProtectedTransactionExecutor = (input: {
  transaction: import("@scry/contracts").ProtectedTransaction;
  dependencies: ProtectedTransactionDependencies;
}) => Promise<ProtectedTransactionExecution>;
