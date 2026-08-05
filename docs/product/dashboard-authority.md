# Dashboard and MCP authority

Scry uses MCP as its sole intelligent authoring and orchestration surface. Agents connected through MCP create and revise Missions, Objectives, Flows, execution plans, and Runs. The dashboard does not imitate these workflows and does not offer rerun controls.

The dashboard is the human observation and safety surface. It retains complete read journeys for Missions, Objectives, Flows, revisions, Runs, attempts, artifacts, reports, privacy state, and Praxis transaction reports and quality findings. It also retains controls whose authority must remain human-owned: cancelling an active Run, approving or rejecting calibration, project setup, protected credential management, authenticated-session revocation, MCP token setup, and incident response.

The current Environment record is internal execution configuration used by MCP, compilation, Runs, credentials, origin policy, and compatibility paths. It is not a customer-facing setup concept and the dashboard must not expose Environment-scoped Veil profiles or policy controls. Veil continues to compile and enforce the effective privacy policy internally, while Run observation reports the policy actually enforced. A future mission-derived multi-site authority model requires a separate product and architecture decision; this compatibility boundary must not be expanded into a new dashboard workflow in the meantime.

When a dashboard view has no records, it directs the user to connect and work through MCP. Existing and legacy Runs remain readable; legacy Runs show an empty Praxis section while preserving their original events and diagnostics.

The backend authoring APIs remain available to authenticated MCP clients. Dashboard read-only status is a shipped-product boundary, not a deletion of the server capabilities used by MCP.
