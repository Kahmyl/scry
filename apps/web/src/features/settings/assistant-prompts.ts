export function createDesktopSetupPrompt(command: string): string {
  return [
    "Install Scry and verify my workspace access. Do not start tests.",
    "",
    "1. Install the plugin",
    "Run the tested command below once. It verifies the installer checksum and package, preserves existing connections, and opens my browser for sign-in.",
    "Use PowerShell on Windows, or the normal shell on macOS and Linux. Do not generate another installer or repeat its package checks. Stop on conflicts or unsupported hosts.",
    "",
    "```",
    command,
    "```",
    "",
    "2. Let me connect my account",
    "Tell me the browser will open. Let me sign in, choose my workspace and approve consent myself.",
    "If setup needs attention, show the returned URL as a clickable link using its linkLabel, and explain the next click in plain language. Do not send me looking for an unspecified host control or log into an existing bare-name MCP server.",
    "",
    "3. Verify access",
    "Only after the installer reports authorization.status=authorized, use read-only list_projects through the installed plugin's scry_beta connection, never an older scry connection.",
    "If that plugin tool is unavailable in this chat, say workspace access is not yet checked. Never claim working sign-in when setup reports needs_attention, or access from installation alone.",
    "Describe the result and any next step in plain language, without tool names or technical jargon.",
  ].join("\n");
}

export const scryPromptExamples = [
  {
    id: "current-work",
    title: "While you’re building",
    description: "Your assistant already knows the app and the changes you’ve made.",
    prompt:
      "Use Scry to test the changes we just made in the environment we’ve been using. Check the affected user journey for regressions, then show me the results with evidence.",
  },
  {
    id: "full-test",
    title: "Start a full test",
    description: "For a new chat, replace the brackets with your app’s details.",
    prompt: [
      "Use Scry to test [app URL] in [environment].",
      "",
      "Focus on:",
      "- Sign-in and account recovery.",
      "- [Main user journey and its expected outcome].",
      "- Validation, error handling and access permissions.",
      "",
      "Use the test accounts and data I provide through Scry’s protected inputs. Stop before purchases, sending invitations or deleting data unless I approve them.",
      "",
      "Report what passed, what failed and what wasn’t tested, with evidence and recommended next steps.",
    ].join("\n"),
  },
  {
    id: "retest",
    title: "Check a fix",
    description: "Continue in the chat where you discussed the issue.",
    prompt:
      "Use Scry to recheck the issue we just fixed. Reuse our existing test context, run the affected checks and tell me whether the fix holds. Don’t repeat passing checks unless this change affects them.",
  },
  {
    id: "resume",
    title: "Pick up where you left off",
    description: "Resume the remaining work without starting the whole test again.",
    prompt:
      "Continue our existing Scry testing from the last report. Keep the same scope and approvals, run the outstanding checks and preserve the earlier results. Tell me what still needs attention.",
  },
  {
    id: "review",
    title: "Understand the results",
    description: "Ask for a clear explanation without running more tests.",
    prompt:
      "Review our latest Scry report. Explain the important findings, show the supporting evidence and recommend what to fix first. Distinguish application issues from testing limitations. Don’t rerun tests or change the app.",
  },
] as const;
