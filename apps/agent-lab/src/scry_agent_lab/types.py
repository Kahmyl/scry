from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field, model_validator


BUDGET_PROFILES = {
    "smoke": {
        "max_turns": 20,
        "max_tool_calls": 15,
        "max_wall_time_seconds": 300,
    },
    "capable_live_journey": {
        "max_turns": 80,
        "max_tool_calls": 100,
        "max_wall_time_seconds": 3600,
    },
}


class McpTool(BaseModel):
    name: str
    description: str | None = None
    input_schema: dict[str, Any]


class McpSnapshot(BaseModel):
    server_info: dict[str, Any] | None = None
    protocol_version: str | None = None
    instructions: str | None = None
    tools: list[McpTool]
    runtime_identity: dict[str, Any] | None = None


class McpToolResult(BaseModel):
    is_error: bool
    content: list[dict[str, Any]] = Field(default_factory=list)
    structured_content: Any | None = None

    def for_model(self) -> dict[str, Any]:
        return {
            "isError": self.is_error,
            "content": self.content,
            "structuredContent": self.structured_content,
        }


class AgentRunSpec(BaseModel):
    objective: str
    mcp_url: str = "http://127.0.0.1:4100/mcp"
    external_run_id: str | None = None
    experiment_id: str | None = None
    expected_attempt_id: str | None = None
    expected_campaign_id: str | None = None
    expected_mission_id: str | None = None
    expected_objective_id: str | None = None
    expected_agent_session_id: str | None = None
    profile: Literal["smoke", "capable_live_journey"] = "smoke"
    max_turns: int | None = Field(default=None, ge=1, le=200)
    max_tool_calls: int | None = Field(default=None, ge=1, le=250)
    max_wall_time_seconds: int | None = Field(
        default=None,
        ge=10,
        le=7200,
    )

    @model_validator(mode="after")
    def resolve_budget_profile(self) -> "AgentRunSpec":
        defaults = BUDGET_PROFILES[self.profile]
        if self.max_turns is None:
            self.max_turns = defaults["max_turns"]
        if self.max_tool_calls is None:
            self.max_tool_calls = defaults["max_tool_calls"]
        if self.max_wall_time_seconds is None:
            self.max_wall_time_seconds = defaults[
                "max_wall_time_seconds"
            ]
        exact = [
            self.expected_attempt_id,
            self.expected_campaign_id,
            self.expected_mission_id,
            self.expected_objective_id,
            self.expected_agent_session_id,
        ]
        if any(exact) and not all(exact):
            raise ValueError(
                "AUTHORITATIVE_Q5_EXACT_IDENTITY_INCOMPLETE"
            )
        return self


class AgentRunResult(BaseModel):
    status: Literal[
        "completed",
        "blocked",
        "stopped",
        "failed",
        "limit_exceeded",
        "cancelled",
    ]
    objective: str
    provider: str
    model: str
    mcp_url: str
    mcp_protocol_version: str | None = None
    mcp_server_info: dict[str, Any] | None = None
    instructions_digest: str | None = None
    advertised_tools: list[str]
    budget_profile: str = "smoke"
    budget_limits: dict[str, int] = Field(default_factory=dict)
    runtime_identity: dict[str, Any] | None = None
    external_run_id: str | None = None
    experiment_id: str | None = None
    turns: int
    tool_calls: int
    invalid_calls: int = 0
    stale_reference_calls: int = 0
    repeated_unchanged_observations: int = 0
    unnecessary_capabilities_calls: int = 0
    completed: bool = False
    duration_ms: int
    latency: dict[str, int | None] = Field(default_factory=dict)
    final_response: str | None = None
    transcript_path: str
    failure: str | None = None
    terminal_outcome: Literal[
        "objective_completed",
        "blocked_user_authority",
        "blocked_system",
        "limit_exceeded",
        "provider_failure",
        "cancelled",
        "model_stopped_without_completion",
    ]
    terminal_blocker: dict[str, Any] | None = None
    completion_evidence: dict[str, Any] | None = None
    termination_category: Literal[
        "completed",
        "blocked",
        "model_stopped",
        "cancelled",
        "harness_limit",
        "provider_error",
        "mcp_error",
        "unknown",
    ] = "unknown"
    lifecycle_settlement: dict[str, Any] | None = None
