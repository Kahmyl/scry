from __future__ import annotations

import json

import pytest

from scry_agent_lab.agent import run_agent
from scry_agent_lab.models import (
    ModelResponse,
    ModelToolCall,
)
from scry_agent_lab.transcript import Transcript
from scry_agent_lab.types import (
    AgentRunSpec,
    McpSnapshot,
    McpTool,
    McpToolResult,
)


class FakeMcp:
    def __init__(self) -> None:
        self.calls: list[
            tuple[str, dict[str, object]]
        ] = []

    async def snapshot(self) -> McpSnapshot:
        return McpSnapshot(
            server_info={
                "name": "fake-scry",
                "version": "1",
            },
            protocol_version="test",
            instructions="Use the echo tool.",
            tools=[
                McpTool(
                    name="echo",
                    description="Echo a supplied value.",
                    input_schema={
                        "type": "object",
                        "properties": {
                            "value": {
                                "type": "string",
                            }
                        },
                        "required": ["value"],
                    },
                )
            ],
        )

    async def call_tool(
        self,
        name: str,
        arguments: dict[str, object],
    ) -> McpToolResult:
        self.calls.append(
            (name, arguments)
        )
        return McpToolResult(
            is_error=False,
            structured_content={
                "value": arguments["value"],
            },
            content=[
                {
                    "type": "text",
                    "text": str(
                        arguments["value"]
                    ),
                }
            ],
        )


class FakeModel:
    def __init__(self) -> None:
        self.turn = 0

    async def complete(
        self,
        messages,
        tools,
    ) -> ModelResponse:
        self.turn += 1

        if self.turn == 1:
            return ModelResponse(
                content=None,
                tool_calls=[
                    ModelToolCall(
                        id="call-1",
                        name="echo",
                        arguments=json.dumps(
                            {
                                "value": "hello",
                            }
                        ),
                    )
                ],
                usage=None,
            )

        return ModelResponse(
            content="Objective complete.",
            tool_calls=[],
            usage=None,
        )


@pytest.mark.asyncio
async def test_external_agent_loop_calls_mcp_and_finishes(
    tmp_path,
) -> None:
    mcp = FakeMcp()
    transcript = Transcript(
        tmp_path / "transcript.jsonl"
    )

    result = await run_agent(
        spec=AgentRunSpec(
            objective="Echo hello.",
            mcp_url="http://fake/mcp",
        ),
        model=FakeModel(),
        mcp=mcp,
        transcript=transcript,
        model_name="fake-model",
        provider_name="fake",
    )

    assert result.status == "completed"
    assert result.tool_calls == 1
    assert result.turns == 2
    assert mcp.calls == [
        (
            "echo",
            {
                "value": "hello",
            },
        )
    ]

    events = [
        json.loads(line)["event"]
        for line in transcript.path.read_text(
            encoding="utf-8"
        ).splitlines()
    ]

    assert events == [
        "mcp_snapshot",
        "model_request",
        "model_response",
        "tool_call",
        "tool_result",
        "model_request",
        "model_response",
    ]
