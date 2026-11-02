---
name: scry-setup
description: Connect an AI client to Scry or check an existing Scry connection. Use for Scry setup and account-linking requests, not to change the application's authentication settings.
---

Help the customer connect their existing Scry account without sharing credentials
in chat. Use the client's supported OAuth connection flow for the remote Scry
MCP server. Installation is not proof that account linking succeeded.

After authorization, use Scry's project-listing tool to verify the workspace is
reachable. Explain which projects are available in plain English. If none exist,
direct the customer to create a project in Scry; do not invent a project or broaden
access. If the tool is unavailable, distinguish a missing installation from a
sign-in or permission problem. Keep internal diagnostics out of the customer reply.

The customer chooses the workspace and grants permission on Scry's consent page.
Do not approve consent, choose a different account, ask for a bearer token, or
edit local credentials on their behalf merely because setup was requested.
Use manual token setup only when explicitly chosen and supported by the client.

Once verified, suggest one short task-specific testing prompt. Test accounts,
target application permissions and approval for consequential actions are separate
from connecting Scry. Do not begin a business journey solely to check the connection.
