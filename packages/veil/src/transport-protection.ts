import type { BrowserCommand } from "@scry/contracts";
import type { ProtectionAuthority } from "./protection-authority.js";

export function protectCommandInput(command: BrowserCommand): BrowserCommand {
  return command.kind === "fill" && command.publicValue !== undefined
    ? { ...command, publicValue: "[PROTECTED:COMMAND_INPUT]" }
    : command;
}

export function safeDomSemanticHint(input: string, authority: ProtectionAuthority): string {
  const normalized = input.replace(/\s+/gu, " ").trim();
  if (!normalized) return "";
  if (normalized.length > 200 || /[\u0000-\u001f\u007f]/u.test(normalized))
    return "[PROTECTED:SEMANTIC_HINT]";
  return authority.sanitize(normalized, "database_safe_field");
}
