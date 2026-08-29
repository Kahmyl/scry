from __future__ import annotations

import asyncio
import json

import pytest

from scry_agent_lab.agent import (
    _mission_completion_evidence,
    run_agent,
)
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
        self.terminations: list[tuple[str, str | None]] = []

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

    async def terminate(
        self,
        reason_code: str,
        blocker_code: str | None = None,
        terminal_outcome: str | None = None,
    ):
        self.terminations.append((reason_code, blocker_code))
        return {
            "settled": True,
            "reasonCode": reason_code,
            "blockerCode": blocker_code,
            "terminalOutcome": terminal_outcome,
        }


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
async def test_model_loop_stop_is_not_objective_completion(
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

    assert result.status == "stopped"
    assert result.tool_calls == 1
    assert result.turns == 2
    assert result.completed is False
    assert result.terminal_outcome == (
        "model_stopped_without_completion"
    )
    assert result.invalid_calls == 0
    assert result.lifecycle_settlement == {
        "settled": True,
        "reasonCode": (
            "EXTERNAL_AGENT_MODEL_STOPPED_WITHOUT_COMPLETION"
        ),
        "blockerCode": None,
        "terminalOutcome": (
            "model_stopped_without_completion"
        ),
    }
    assert mcp.terminations == [
        (
            "EXTERNAL_AGENT_MODEL_STOPPED_WITHOUT_COMPLETION",
            None,
        )
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

    assert result.completed is False
    assert result.terminal_outcome == (
        "model_stopped_without_completion"
    )
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
        "blockerCode": None,
        "terminalOutcome": "limit_exceeded",
    }
    assert result.budget_profile == "capable_live_journey"
    assert result.budget_limits["maxToolCalls"] == 1
    assert mcp.terminations == [
        ("MAX_TOOL_CALLS_EXCEEDED", None)
    ]


class BlockingMcp(FakeMcp):
    async def snapshot(self) -> McpSnapshot:
        snapshot = await super().snapshot()
        snapshot.tools[0].name = "get_operating_context"
        return snapshot

    async def call_tool(
        self,
        name: str,
        arguments: dict[str, object],
    ) -> McpToolResult:
        self.calls.append((name, arguments))
        return McpToolResult(
            is_error=False,
            structured_content={
                "continuation": {
                    "userAuthorityRequired": True,
                    "blockerCode": (
                        "MISSION_SELECTION_REQUIRED"
                    ),
                    "safeActions": ["list_missions"],
                }
            },
        )


class BlockingModel:
    def __init__(self) -> None:
        self.turn = 0

    async def complete(self, messages, tools) -> ModelResponse:
        self.turn += 1
        if self.turn == 1:
            return ModelResponse(
                content=None,
                tool_calls=[
                    ModelToolCall(
                        id="blocked-1",
                        name="get_operating_context",
                        arguments="{}",
                    )
                ],
                usage=None,
            )
        return ModelResponse(
            content="I need the user's Mission selection.",
            tool_calls=[],
            usage=None,
        )


@pytest.mark.asyncio
async def test_structured_user_authority_blocker_is_blocked(
    tmp_path,
) -> None:
    mcp = BlockingMcp()
    result = await run_agent(
        spec=AgentRunSpec(objective="Perform new work."),
        model=BlockingModel(),
        mcp=mcp,
        transcript=Transcript(tmp_path / "blocked.jsonl"),
        model_name="fake-model",
        provider_name="fake-provider",
    )

    assert result.status == "blocked"
    assert result.completed is False
    assert result.terminal_outcome == "blocked_user_authority"
    assert result.terminal_blocker == {
        "code": "MISSION_SELECTION_REQUIRED",
        "userAuthorityRequired": True,
        "safeActions": ["list_missions"],
    }
    assert mcp.terminations == [
        (
            "EXTERNAL_AGENT_BLOCKED_USER_AUTHORITY",
            "MISSION_SELECTION_REQUIRED",
        )
    ]


class CompletionMcp(FakeMcp):
    async def snapshot(self) -> McpSnapshot:
        snapshot = await super().snapshot()
        snapshot.tools[0].name = "publish_mission_report"
        return snapshot

    async def call_tool(
        self,
        name: str,
        arguments: dict[str, object],
    ) -> McpToolResult:
        self.calls.append((name, arguments))
        return McpToolResult(
            is_error=False,
            structured_content={
                "report": {
                    "id": (
                        "22222222-2222-4222-8222-222222222222"
                    ),
                    "missionId": (
                        "11111111-1111-4111-8111-111111111111"
                    ),
                    "status": "published",
                }
            },
        )


class CompletionModel:
    def __init__(self) -> None:
        self.turn = 0

    async def complete(self, messages, tools) -> ModelResponse:
        self.turn += 1
        if self.turn == 1:
            return ModelResponse(
                content=None,
                tool_calls=[
                    ModelToolCall(
                        id="complete-1",
                        name="publish_mission_report",
                        arguments="{}",
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
async def test_published_mission_report_is_objective_completion_evidence(
    tmp_path,
) -> None:
    mcp = CompletionMcp()
    result = await run_agent(
        spec=AgentRunSpec(objective="Complete a Mission."),
        model=CompletionModel(),
        mcp=mcp,
        transcript=Transcript(tmp_path / "completed.jsonl"),
        model_name="fake-model",
        provider_name="fake-provider",
    )

    assert result.status == "completed"
    assert result.completed is True
    assert result.terminal_outcome == "objective_completed"
    assert result.completion_evidence == {
        "kind": "mission_report",
        "missionId": (
            "11111111-1111-4111-8111-111111111111"
        ),
        "reportId": (
            "22222222-2222-4222-8222-222222222222"
        ),
        "reportStatus": "published",
    }
    assert mcp.terminations == [
        ("EXTERNAL_AGENT_OBJECTIVE_COMPLETED", None)
    ]


class CancelledModel:
    async def complete(self, messages, tools) -> ModelResponse:
        raise asyncio.CancelledError


@pytest.mark.asyncio
async def test_harness_cancellation_is_a_terminal_result(
    tmp_path,
) -> None:
    mcp = FakeMcp()
    result = await run_agent(
        spec=AgentRunSpec(objective="Wait for cancellation."),
        model=CancelledModel(),
        mcp=mcp,
        transcript=Transcript(tmp_path / "cancelled.jsonl"),
        model_name="fake-model",
        provider_name="fake-provider",
    )

    assert result.status == "cancelled"
    assert result.completed is False
    assert result.failure == "EXTERNAL_AGENT_HARNESS_CANCELLED"
    assert result.terminal_outcome == "cancelled"
    assert result.termination_category == "cancelled"
    assert mcp.terminations == [
        ("EXTERNAL_AGENT_HARNESS_CANCELLED", None)
    ]


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


def test_authoritative_completion_requires_every_exact_identity() -> None:
    spec = AgentRunSpec(
        objective="Q5",
        expected_attempt_id="attempt-q5",
        expected_campaign_id="campaign-q5",
        expected_mission_id="mission-q5",
        expected_objective_id="objective-q5",
        expected_agent_session_id="agent-q5",
    )
    payload = {
        "structuredContent": {
            "report": {
                "id": "report-q5",
                "missionId": "mission-q5",
                "status": "published",
            }
        }
    }
    lifecycle = {
        "campaignId": "campaign-q5",
        "runId": "run-q5",
        "runFinalized": True,
        "evidenceAccepted": True,
    }
    arguments = {
        "missionId": "mission-q5",
        "agentSessionId": "agent-q5",
    }
    assert _mission_completion_evidence(
        "publish_mission_report",
        payload,
        arguments,
        spec,
        lifecycle,
    ) is not None
    payload["structuredContent"]["report"]["missionId"] = (
        "unrelated-mission"
    )
    assert _mission_completion_evidence(
        "publish_mission_report",
        payload,
        arguments,
        spec,
        lifecycle,
    ) is None


class Q5JourneyMcp(FakeMcp):
    # Frozen public surface mirrored from @scry/contracts. The MCP package's
    # contract-digest test is the source-of-truth cross-check for this list.
    profile_tools = [
        "get_capabilities",
        "get_operating_context",
        "list_environments",
        "list_project_credentials",
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
        "grant_mission_execution_authorization",
        "update_mission_objective",
        "finalize_agent_work",
        "preview_mission_report",
        "publish_mission_report",
        "end_agent_session",
    ]
    journey = [
        "get_operating_context",
        "list_project_credentials",
        "start_praxis_session",
        "observe_praxis_session",
        "start_run",
        "dispatch_run_operation",
        "finalize_run",
        "accept_objective_evidence",
        "finalize_agent_work",
        "preview_mission_report",
        "publish_mission_report",
        "end_agent_session",
    ]

    async def snapshot(self) -> McpSnapshot:
        return McpSnapshot(
            server_info={"name": "scry-q5-authoritative", "version": "1"},
            protocol_version="2025-11-25",
            instructions="Use only the qualification-scoped public Scry contract.",
            tools=[
                McpTool(
                    name=name,
                    description=f"Q5 {name}",
                    input_schema={"type": "object"},
                )
                for name in self.profile_tools
            ],
        )

    async def call_tool(
        self,
        name: str,
        arguments: dict[str, object],
    ) -> McpToolResult:
        self.calls.append((name, arguments))
        structured: dict[str, object] = {"accepted": True}
        if name == "start_run":
            structured = {"run": {"runId": "run-q5"}}
        elif name == "publish_mission_report":
            structured = {
                "report": {
                    "id": "report-q5",
                    "missionId": "mission-q5",
                    "status": "published",
                }
            }
        return McpToolResult(
            is_error=False,
            structured_content=structured,
            content=[{"type": "text", "text": "accepted"}],
        )


class Q5JourneyModel:
    def __init__(self) -> None:
        self.turn = 0

    async def complete(self, messages, tools) -> ModelResponse:
        if self.turn == len(Q5JourneyMcp.journey):
            return ModelResponse(
                content="Exact Q5 journey complete.",
                tool_calls=[],
                usage=None,
            )
        name = Q5JourneyMcp.journey[self.turn]
        self.turn += 1
        arguments: dict[str, object] = {}
        if name == "start_run":
            arguments["qualificationCampaignAuthorizationId"] = "campaign-q5"
        elif name == "finalize_run":
            arguments["runId"] = "run-q5"
        elif name == "accept_objective_evidence":
            arguments.update(
                {
                    "missionId": "mission-q5",
                    "objectiveId": "objective-q5",
                    "runId": "run-q5",
                }
            )
        elif name == "publish_mission_report":
            arguments.update(
                {
                    "missionId": "mission-q5",
                    "agentSessionId": "agent-q5",
                }
            )
        return ModelResponse(
            content=None,
            tool_calls=[
                ModelToolCall(
                    id=f"q5-{self.turn}",
                    name=name,
                    arguments=json.dumps(arguments),
                )
            ],
            usage=None,
        )


@pytest.mark.asyncio
async def test_deterministic_q5_agent_completes_the_exact_public_journey(tmp_path) -> None:
    mcp = Q5JourneyMcp()
    result = await run_agent(
        spec=AgentRunSpec(
            objective="Complete exact Q5 journey",
            profile="capable_live_journey",
            expected_attempt_id="attempt-q5",
            expected_campaign_id="campaign-q5",
            expected_mission_id="mission-q5",
            expected_objective_id="objective-q5",
            expected_agent_session_id="agent-q5",
        ),
        model=Q5JourneyModel(),
        mcp=mcp,
        transcript=Transcript(tmp_path / "q5-journey.jsonl"),
        model_name="deterministic-q5",
        provider_name="deterministic",
    )
    assert result.completed is True
    assert result.completion_evidence == {
        "kind": "mission_report",
        "missionId": "mission-q5",
        "reportId": "report-q5",
        "reportStatus": "published",
        "attemptId": "attempt-q5",
        "campaignId": "campaign-q5",
        "objectiveId": "objective-q5",
        "runId": "run-q5",
        "agentSessionId": "agent-q5",
    }
    assert [name for name, _ in mcp.calls] == Q5JourneyMcp.journey
    assert len((await mcp.snapshot()).tools) == 30


def test_transcript_redacts_nested_keys_and_all_seeded_canaries(
    tmp_path,
    monkeypatch,
) -> None:
    canaries = [
        "provider-key-canary",
        "vitract-credential-canary",
        "cookie-canary",
        "session-token-canary",
        "authorization-canary",
        "protected-request-canary",
        "protected-output-canary",
    ]
    monkeypatch.setenv(
        "SCRY_AGENT_LAB_PROTECTED_CANARIES",
        json.dumps(canaries),
    )
    target = tmp_path / "privacy.jsonl"
    Transcript(target).write(
        "failure",
        {
            "authorization": canaries[4],
            "nested": {
                "cookie": canaries[2],
                "message": " ".join(canaries),
                "protectedRequestBody": canaries[5],
                "protectedOutputValue": canaries[6],
            },
        },
    )
    written = target.read_text()
    assert "[REDACTED]" in written
    assert all(canary not in written for canary in canaries)
