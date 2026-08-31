export const Q5_MCP_PROFILE = "q5-thin-kernel-v3" as const;
export const Q5_MCP_PROTOCOL_VERSION = "2025-11-25" as const;
export const Q5_MCP_CONTRACT_DIGEST =
  "7264b57f48ca7656342502aea2f266d32dd400663858796c39f9dc98ac52164d" as const;

export const Q5_MCP_TOOL_NAMES = [
  "get_capabilities",
  "get_operating_context",
  "list_environments",
  "observe_operation_contracts",
  "list_mission_values",
  "reserve_prepared_protected_operation",
  "dispatch_prepared_protected_operation",
  "list_mission_continuations",
  "start_praxis_session",
  "observe_praxis_session",
  "inspect_praxis_region",
  "read_praxis_public_value",
  "inspect_praxis_resources",
  "read_praxis_public_resource",
  "inspect_praxis_structure",
  "read_praxis_public_structure_value",
  "inspect_praxis_runtime_state",
  "read_praxis_public_runtime_value",
  "get_praxis_session",
  "reconcile_unknown_operation",
  "close_praxis_session",
  "start_run",
  "dispatch_run_operation",
  "attach_run_praxis_session",
  "finalize_run",
  "get_run",
  "accept_objective_evidence",
  "get_mission",
  "update_mission_objective",
  "finalize_agent_work",
  "set_mission_recording_selection",
  "preview_mission_report",
  "publish_mission_report",
  "end_agent_session",
] as const;

export const Q5_REQUIRED_EVIDENCE_KINDS = [
  "public_discovery",
  "protected_authentication",
  "business_mutation",
  "external_effect_binding",
  "exact_retrieval",
  "run_operation",
  "run_finalization",
  "objective_acceptance",
  "mission_report",
] as const;
