import type { ProtectedTransaction } from "@scry/contracts";
import { requirePraxisSuccess, resolveTargetLocator } from "@scry/praxis";
import type { Page } from "playwright";

import type { ProtectedTransactionDependencies } from "./protected-transaction-coordinator.js";
import { ProtectedTransactionPhaseError as PhaseError } from "./protected-transaction-errors.js";

export async function executeProtectedPreparation(
  page: Page,
  transaction: ProtectedTransaction,
  dependencies: ProtectedTransactionDependencies,
) {
  for (const action of transaction.preparation.actions) {
    try {
      if (action.type === "navigate") {
        await page.goto(action.url, {
          waitUntil: "domcontentloaded",
          ...timeout(action.timeoutMs),
        });
        continue;
      }
      if (action.type === "clickNavigation") {
        await requirePraxisSuccess({
          page,
          intent: action.target,
          operation: { type: "activate" },
          context: protectedContext(transaction, action.timeoutMs, dependencies.allowedOrigins),
          signal: dependencies.signal ?? new AbortController().signal,
        });
        continue;
      }
      if (action.type === "clickPublicInput") {
        const input = transaction.inputs[action.input];
        if (!input || input.classification !== "public" || typeof input.value !== "string") {
          throw new PhaseError("PUBLIC_NAVIGATION_INPUT_INVALID", "preparation", "safe_to_retry");
        }
        await page.getByText(input.value, { exact: action.exact }).click(timeout(action.timeoutMs));
        continue;
      }
      if (action.type === "waitFor") {
        await requirePraxisSuccess({
          page,
          intent: action.target,
          operation: { type: "wait_for_state", state: action.state },
          context: protectedContext(transaction, action.timeoutMs, dependencies.allowedOrigins),
          signal: dependencies.signal ?? new AbortController().signal,
        });
        continue;
      }
      if (action.type === "assertion") {
        await dependencies.verifyAssertions(page, [action.assertion]);
        continue;
      }

      const input = transaction.inputs[action.input];
      if (!input) throw new PhaseError("TRANSACTION_INPUT_MISSING", "preparation", "safe_to_retry");
      if (action.type === "fillKnownSecret") {
        if (input.classification !== "known_secret") {
          throw new PhaseError(
            "TRANSACTION_INPUT_CLASSIFICATION_MISMATCH",
            "preparation",
            "do_not_retry",
          );
        }
        const secret = await dependencies.resolveKnownSecret(input.credentialRef);
        dependencies.redactor.add(secret);
        await requirePraxisSuccess({
          page,
          intent: action.target,
          operation: {
            type: "enter_text",
            input: { reference: input.credentialRef, classification: "known_secret" },
          },
          context: protectedContext(transaction, action.timeoutMs, dependencies.allowedOrigins),
          signal: dependencies.signal ?? new AbortController().signal,
          resolveInput: async () => secret,
        });
      } else {
        if (input.classification !== "public") {
          throw new PhaseError(
            "TRANSACTION_INPUT_CLASSIFICATION_MISMATCH",
            "preparation",
            "do_not_retry",
          );
        }
        if (action.type === "fillPublicInput") {
          await requirePraxisSuccess({
            page,
            intent: action.target,
            operation: {
              type: "enter_text",
              input: { reference: action.input, classification: "public" },
            },
            context: protectedContext(transaction, action.timeoutMs, dependencies.allowedOrigins),
            signal: dependencies.signal ?? new AbortController().signal,
            resolveInput: async () => String(input.value),
          });
        }
        if (action.type === "selectPublicInput") {
          await requirePraxisSuccess({
            page,
            intent: action.target,
            operation: {
              type: "select_option",
              input: { reference: action.input, classification: "public" },
            },
            context: protectedContext(transaction, action.timeoutMs, dependencies.allowedOrigins),
            signal: dependencies.signal ?? new AbortController().signal,
            resolveInput: async () => String(input.value),
          });
        }
        if (action.type === "checkPublicInput") {
          if (typeof input.value !== "boolean") {
            throw new PhaseError("TRANSACTION_INPUT_TYPE_MISMATCH", "preparation", "do_not_retry");
          }
          await requirePraxisSuccess({
            page,
            intent: action.target,
            operation: { type: "set_checked", checked: input.value },
            context: protectedContext(transaction, action.timeoutMs, dependencies.allowedOrigins),
            signal: dependencies.signal ?? new AbortController().signal,
          });
        }
      }
    } catch (error) {
      if (error instanceof PhaseError) throw error;
      throw new PhaseError(
        `PREPARATION_${action.type.replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase()}_FAILED`,
        "preparation",
        "safe_to_retry",
      );
    }
  }
}

export async function verifyProtectedTransactionAssertions(
  page: Page,
  assertions: ProtectedTransaction["preparation"]["assertions"],
  transaction: ProtectedTransaction,
  dependencies: ProtectedTransactionDependencies,
  phase: PhaseError["phase"] = "preparation",
) {
  for (const assertion of assertions) {
    if (assertion.type !== "fieldValueMatchesInput" && assertion.type !== "textMatchesInput") {
      try {
        await dependencies.verifyAssertions(page, [assertion]);
      } catch {
        throw new PhaseError(
          `TRANSACTION_${assertion.type.toUpperCase()}_ASSERTION_FAILED`,
          phase,
          phase === "continuation" ? "manual_review" : "safe_to_retry",
        );
      }
      continue;
    }
    const code = `${phase.toUpperCase()}_${assertion.input.replace(/[^a-z0-9]+/gi, "_").toUpperCase()}_VERIFICATION_FAILED`;
    try {
      const input = transaction.inputs[assertion.input];
      if (!input) {
        throw new PhaseError(
          "TRANSACTION_INPUT_MISSING",
          phase,
          phase === "continuation" ? "manual_review" : "safe_to_retry",
        );
      }
      const locator = await resolveTargetLocator(page, assertion.target);
      const expected =
        input.classification === "known_secret"
          ? await dependencies.resolveKnownSecret(input.credentialRef)
          : String(input.value);
      if (input.classification === "known_secret") dependencies.redactor.add(expected);
      const deadline = Date.now() + (assertion.timeoutMs ?? 10_000);
      let matches = false;
      do {
        const actual =
          assertion.type === "fieldValueMatchesInput"
            ? await locator.inputValue({ timeout: Math.max(100, deadline - Date.now()) })
            : ((await locator.textContent({ timeout: Math.max(100, deadline - Date.now()) })) ??
              "");
        matches =
          assertion.type === "textMatchesInput" && !assertion.exact
            ? actual.includes(expected)
            : actual.trim() === expected;
        if (!matches && Date.now() < deadline)
          await new Promise((resolve) => setTimeout(resolve, 100));
      } while (!matches && Date.now() < deadline);
      if (!matches) {
        throw new PhaseError(
          code,
          phase,
          phase === "continuation" ? "manual_review" : "safe_to_retry",
        );
      }
    } catch (error) {
      if (error instanceof PhaseError) throw error;
      throw new PhaseError(
        code,
        phase,
        phase === "continuation" ? "manual_review" : "safe_to_retry",
      );
    }
  }
}

function protectedContext(
  transaction: ProtectedTransaction,
  timeoutMs: number | undefined,
  allowedOrigins: string[],
) {
  return {
    stepId: transaction.operationId,
    channel: "protected" as const,
    ordinal: 0,
    allowedOrigins,
    timeoutMs: timeoutMs ?? 10_000,
    privacy: {
      state: "protected" as const,
      allowedChannels: ["public_dom", "accessibility"],
      suppressedChannels: ["visual", "ocr"],
    },
  };
}

function timeout(timeoutMs?: number) {
  return timeoutMs === undefined ? {} : { timeout: timeoutMs };
}
