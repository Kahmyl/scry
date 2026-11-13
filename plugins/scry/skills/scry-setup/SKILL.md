---
name: scry-setup
description: Connect an AI client to Scry or check an existing Scry connection. Use for Scry setup and account-linking requests, not to change the application's authentication settings.
---

Help the customer connect their existing Scry account through the client's supported
OAuth flow without sharing credentials in chat. Installation is not proof of
account linking. The customer chooses the workspace and grants permission on
Scry's consent page. Do not approve consent, switch accounts, request a bearer
token or edit local credentials merely because setup was requested. Use manual
token setup only when explicitly chosen and supported by that client.

After authorization, use `list_projects` to verify an actual authenticated read.
Explain available Projects in ordinary language. If none exist, direct the customer
to create a Project in Scry; do not invent one or broaden access. A successful read
verifies this connection, not every host tool or application permission.

Keep successful sign-in separate from missing tools. If available, use
`get_connection_diagnostics` with only tool names actually exposed in this chat.
Its server authorization facts and client-reported inventory are distinct; it
cannot certify or reload the client's catalog. If tools are entirely absent, use
Scry's dashboard connection diagnostics as the independent route. Do not repeatedly
ask someone to select a missing plugin or reconnect a healthy login.

Identify the client and installation surface before prescribing recovery. For a
confirmed Codex Desktop packaged Scry plugin with stale tools and no separate
refresh control, switch the whole plugin off and on once, then verify an
authenticated Project read and the required tools. A custom MCP server uses its
client's supported server reload/reconnect controls; do not invent a packaged
plugin switch for it. If the client/surface is unknown, ask one short natural
question, such as “Which app are you using, and did you add Scry as a plugin or a
custom MCP server?” Do not ask for internal IDs, operator credentials or secrets.
After one supported recovery fails, preserve the working login, state the remaining
host-discovery limit and hand off to Scry support at https://scry.giize.com/support
with the known client/surface and safe diagnostic facts. Never claim automatic
background repair or that missing tools establish an application failure.

Once verified, suggest one short task-specific testing prompt. Test accounts,
target application permissions and consequential-action approvals are separate
from connecting Scry. Do not begin a business journey solely to check the connection.
