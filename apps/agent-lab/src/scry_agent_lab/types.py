from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


class McpTool(BaseModel):
    name: str
    description: str | None = None
    input_schema: dict[str, Any]


class McpSnapshot(BaseModel):
    server_info: dict[str, Any] | None = None
    protocol_version: str | None = None
    instructions: str | None = None
    tools: list[McpTool]


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
    max_turns: int = Field(default=20, ge=1, le=100)
    max_tool_calls: int = Field(default=15, ge=1, le=100)


class AgentRunResult(BaseModel):
    status: Literal["completed", "failed", "limit_exceeded"]
    objective: str
    provider: str
    model: str
    mcp_url: str
    mcp_protocol_version: str | None = None
    mcp_server_info: dict[str, Any] | None = None
    instructions_digest: str | None = None
    advertised_tools: list[str]
    turns: int
    tool_calls: int
    duration_ms: int
    final_response: str | None = None
    transcript_path: str
    failure: str | None = None
