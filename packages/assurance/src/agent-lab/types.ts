export type AgentLabRunStatus =
  "completed" | "blocked" | "stopped" | "failed" | "limit_exceeded" | "cancelled";

export type AgentLabRunSpec = Readonly<{
  objective: string;
  profile?: "smoke" | "capable_live_journey";
  provider?: "local" | "deepseek";
  mcpUrl?: string;
  model?: string;
  maxTurns?: number;
  maxToolCalls?: number;
  maxWallTimeSeconds?: number;
  externalRunId?: string;
  experimentId?: string;
  outputDirectory?: string;
}>;

export type AgentLabRunResult = Readonly<{
  status: AgentLabRunStatus;
  objective: string;
  provider: string;
  model: string;
  mcp_url: string;
  mcp_protocol_version?: string | null;
  mcp_server_info?: Record<string, unknown> | null;
  instructions_digest?: string | null;
  advertised_tools: string[];
  budget_profile?: string;
  budget_limits?: Record<string, number>;
  runtime_identity?: Record<string, unknown> | null;
  external_run_id?: string | null;
  experiment_id?: string | null;
  turns: number;
  tool_calls: number;
  invalid_calls: number;
  stale_reference_calls: number;
  repeated_unchanged_observations: number;
  unnecessary_capabilities_calls: number;
  completed: boolean;
  duration_ms: number;
  latency?: Record<string, number | null>;
  final_response?: string | null;
  transcript_path: string;
  failure?: string | null;
  terminal_outcome?:
    | "objective_completed"
    | "blocked_user_authority"
    | "blocked_system"
    | "limit_exceeded"
    | "provider_failure"
    | "cancelled"
    | "model_stopped_without_completion";
  terminal_blocker?: Record<string, unknown> | null;
  completion_evidence?: Record<string, unknown> | null;
  termination_category?:
    | "completed"
    | "blocked"
    | "model_stopped"
    | "cancelled"
    | "harness_limit"
    | "provider_error"
    | "mcp_error"
    | "unknown";
  lifecycle_settlement?: Record<string, unknown> | null;
}>;

export type AgentLabInvocation = Readonly<{
  result: AgentLabRunResult;
  outputDirectory: string;
}>;
