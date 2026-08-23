export type AgentLabRunStatus = "completed" | "failed" | "limit_exceeded";

export type AgentLabRunSpec = Readonly<{
  objective: string;
  provider?: "local" | "deepseek";
  mcpUrl?: string;
  model?: string;
  maxTurns?: number;
  maxToolCalls?: number;
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
  turns: number;
  tool_calls: number;
  invalid_calls: number;
  stale_reference_calls: number;
  repeated_unchanged_observations: number;
  unnecessary_capabilities_calls: number;
  completed: boolean;
  duration_ms: number;
  final_response?: string | null;
  transcript_path: string;
  failure?: string | null;
}>;

export type AgentLabInvocation = Readonly<{
  result: AgentLabRunResult;
  outputDirectory: string;
}>;
