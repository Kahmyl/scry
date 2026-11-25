/** Shared by submit, claim and recovery reporting. Caller supplies a fixed SQL
 * alias only; never interpolate request data into this predicate. Unknown or
 * malformed step truth dominates a reassuring aggregate label.
 */
export function uncertainNativeActionSql(alias: "bc" | "browser_commands"): string {
  const r = `${alias}.safe_result`;
  return `(CASE WHEN ${r}->'nativeActionFence'='{"version":1,"state":"known"}'::jsonb THEN false
    WHEN ${r}->'nativeActionFence'='{"version":1,"state":"uncertain"}'::jsonb THEN true
    ELSE (${r}->>'execution' IN ('unknown','partial') OR
    (${r}->>'execution'='not_dispatched' AND (${r}->>'reason'='dispatch_started' OR COALESCE(${r}->>'businessOutcome','unknown')<>'not_dispatched')) OR
    (${r} ? 'execution' AND (jsonb_typeof(${r}->'execution')<>'string' OR
      COALESCE(${r}->>'execution','unknown') NOT IN ('completed','tool_error','not_dispatched'))) OR
    (${r} ? 'receipts' AND COALESCE(${r}->>'execution','unknown') NOT IN ('completed','tool_error','not_dispatched')) OR
    (${r}->>'execution'='not_dispatched' AND ${r} ? 'receipts') OR
    (${r} ? 'receipts' AND CASE WHEN jsonb_typeof(${r}->'receipts')='array' THEN
      EXISTS(SELECT 1 FROM jsonb_array_elements(${r}->'receipts') AS step
        WHERE COALESCE(step->>'execution','unknown') NOT IN ('completed','tool_error','not_dispatched')
          OR (${r}->>'execution'='completed' AND step->>'execution'<>'completed'))
      ELSE true END) OR
    (${r} ? 'receipts' AND ${r}->>'execution'<>'not_dispatched' AND COALESCE(jsonb_array_length(CASE
      WHEN jsonb_typeof(${r}->'receipts')='array' THEN ${r}->'receipts' ELSE '[]'::jsonb END),0)=0)) END)`;
}

export class NativeActionReconciliationRequired extends Error {
  constructor(readonly relatedCommandId: string) {
    super("SCRY_BROWSER_COMMAND_RECONCILIATION_REQUIRED");
  }
}

export const nativeActionIncidentId = (commandId: string): string => `scry-command-${commandId}`;
