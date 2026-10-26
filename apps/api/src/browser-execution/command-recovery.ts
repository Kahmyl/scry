/** Finite runtime stages that require nonterminal recovery, not ordinary action
 * failure. Classification is separate from Veil's disclosure allowlist. */
const runtimeRecoveryCodes = [
  "SCRY_BROWSER_COMMAND_DRAIN_UNCONFIRMED",
  "SCRY_BROWSER_PROCESS_TERMINATION_UNCONFIRMED",
  "SCRY_BROWSER_RECORDER_STOP_TIMEOUT",
  "SCRY_BROWSER_OWNER_RETIREMENT_UNCONFIRMED",
] as const;
export type RuntimeRecoveryCode = (typeof runtimeRecoveryCodes)[number];
export function runtimeRecoveryCode(value: unknown): RuntimeRecoveryCode | undefined {
  return runtimeRecoveryCodes.find((code) => code === value);
}
