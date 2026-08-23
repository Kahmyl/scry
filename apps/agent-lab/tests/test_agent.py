from __future__ import annotations

import json

import pytest

from scry_agent_lab.agent import run_agent
from scry_agent_lab.cli import parser
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
        self.terminations: list[str] = []

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

    async def terminate(self, reason_code: str):
        self.terminations.append(reason_code)
        return {"settled": True, "reasonCode": reason_code}


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
    assert result.completed is True
    assert result.invalid_calls == 0
    assert result.lifecycle_settlement == {
        "settled": True,
        "reasonCode": "EXTERNAL_AGENT_HARNESS_COMPLETED",
    }
    assert mcp.terminations == [
        "EXTERNAL_AGENT_HARNESS_COMPLETED"
    ]
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
        "lifecycle_settlement",
    ]


class MetricsMcp(FakeMcp):
    async def call_tool(
        self,
        name: str,
        arguments: dict[str, object],
    ) -> McpToolResult:
        self.calls.append((name, arguments))
        if name == "stale_action":
            return McpToolResult(
                is_error=True,
                structured_content={
                    "rejection": {
                        "code": "CONTEXT_REFERENCE_STALE",
                        "rejectionClass": "stale_authority",
                        "safeActions": ["observe_praxis_session"],
                    }
                },
            )
        if name == "invalid_action":
            return McpToolResult(
                is_error=True,
                structured_content={
                    "rejection": {
                        "code": "REQUEST_INVALID",
                        "rejectionClass": "invalid_input",
                        "safeActions": [],
                    }
                },
            )
        return McpToolResult(
            is_error=False,
            structured_content={"state": "unchanged"},
        )


class MetricsModel:
    def __init__(self) -> None:
        self.calls = [
            "get_capabilities",
            "get_state",
            "get_state",
            "stale_action",
            "invalid_action",
        ]
        self.turn = 0

    async def complete(self, messages, tools) -> ModelResponse:
        self.turn += 1
        if self.calls:
            name = self.calls.pop(0)
            return ModelResponse(
                content=None,
                tool_calls=[
                    ModelToolCall(
                        id=f"call-{self.turn}",
                        name=name,
                        arguments="{}",
                    )
                ],
                usage=None,
            )
        return ModelResponse(
            content="Stopped safely.",
            tool_calls=[],
            usage=None,
        )


@pytest.mark.asyncio
async def test_agent_metrics_classify_behavior_not_prompt_strings(
    tmp_path,
) -> None:
    result = await run_agent(
        spec=AgentRunSpec(
            objective="Inspect the current state safely.",
            mcp_url="http://fake/mcp",
        ),
        model=MetricsModel(),
        mcp=MetricsMcp(),
        transcript=Transcript(tmp_path / "metrics.jsonl"),
        model_name="fake-model",
        provider_name="fake",
    )

    assert result.completed is True
    assert result.invalid_calls == 1
    assert result.stale_reference_calls == 1
    assert result.repeated_unchanged_observations == 1
    assert result.unnecessary_capabilities_calls == 1


class EndlessModel:
    async def complete(self, messages, tools) -> ModelResponse:
        return ModelResponse(
            content=None,
            tool_calls=[
                ModelToolCall(
                    id="endless",
                    name="echo",
                    arguments='{"value":"again"}',
                )
            ],
            usage=None,
        )


@pytest.mark.asyncio
async def test_harness_limit_settles_owned_lifecycle(tmp_path) -> None:
    mcp = FakeMcp()
    result = await run_agent(
        spec=AgentRunSpec(
            objective="Keep working.",
            profile="capable_live_journey",
            max_tool_calls=1,
            external_run_id="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        ),
        model=EndlessModel(),
        mcp=mcp,
        transcript=Transcript(tmp_path / "limit.jsonl"),
        model_name="fake-model",
        provider_name="fake-provider",
    )

    assert result.status == "limit_exceeded"
    assert result.failure == "MAX_TOOL_CALLS_EXCEEDED"
    assert result.termination_category == "harness_limit"
    assert result.lifecycle_settlement == {
        "settled": True,
        "reasonCode": "MAX_TOOL_CALLS_EXCEEDED",
    }
    assert result.budget_profile == "capable_live_journey"
    assert result.budget_limits["maxToolCalls"] == 1
    assert mcp.terminations == ["MAX_TOOL_CALLS_EXCEEDED"]


def test_budget_profiles_have_finite_canonical_defaults() -> None:
    smoke = AgentRunSpec(objective="Smoke")
    capable = AgentRunSpec(
        objective="Full journey",
        profile="capable_live_journey",
    )

    assert (smoke.max_turns, smoke.max_tool_calls) == (20, 15)
    assert smoke.max_wall_time_seconds == 300
    assert (capable.max_turns, capable.max_tool_calls) == (80, 100)
    assert capable.max_wall_time_seconds == 3600


def test_cli_preserves_profile_defaults_and_explicit_overrides() -> None:
    default = parser().parse_args(
        ["run", "--objective", "Smoke"]
    )
    override = parser().parse_args(
        [
            "run",
            "--objective",
            "Journey",
            "--profile",
            "capable_live_journey",
            "--max-turns",
            "90",
            "--max-tool-calls",
            "120",
            "--max-wall-time-seconds",
            "4000",
        ]
    )

    assert default.profile == "smoke"
    assert default.max_turns is None
    assert default.max_tool_calls is None
    assert default.max_wall_time_seconds is None
    assert override.profile == "capable_live_journey"
    assert (override.max_turns, override.max_tool_calls) == (90, 120)
    assert override.max_wall_time_seconds == 4000
