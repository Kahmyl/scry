from __future__ import annotations

import asyncio
import hashlib
import json
import os
import time
from typing import Any

from .transcript import Transcript
from .types import AgentRunResult, AgentRunSpec, McpSnapshot


SYSTEM_PROMPT = """You are an external AI agent using Scry through MCP.

You have no access to Scry source code, databases, internal services, browser
handles, or implementation details. Your only Scry capabilities are the MCP
instructions and MCP tools supplied to you.

Follow the MCP server instructions exactly.
Use tools when the objective requires them.
Never invent a tool result.
Never claim an action succeeded unless the tool result supports it.
Do not guess internal Scry state.
Stop when the objective is complete or when the available MCP interface cannot
safely complete it.
"""


def instructions_digest(snapshot: McpSnapshot) -> str | None:
    if snapshot.instructions is None:
        return None
    return hashlib.sha256(
        snapshot.instructions.encode("utf-8")
    ).hexdigest()


def model_tools(snapshot: McpSnapshot) -> list[dict[str, Any]]:
    return [
        {
            "type": "function",
            "function": {
                "name": tool.name,
                "description": tool.description or "",
                "parameters": tool.input_schema,
            },
        }
        for tool in snapshot.tools
    ]


def _model_tool_payload(
    payload: dict[str, Any],
) -> dict[str, Any]:
    """Project an MCP tool result for the external model.

    full:
        Preserve the existing Agent Lab representation.

    structured:
        Remove text content only when it is provably an exact JSON
        serialization of structuredContent.

    The complete MCP result remains available to transcript, metrics,
    blocker/completion detection, and lifecycle handling.
    """
    projection = os.getenv(
        "SCRY_AGENT_LAB_TOOL_RESULT_PROJECTION",
        "full",
    ).strip().lower()

    if projection == "full":
        return payload

    if projection != "structured":
        raise ValueError(
            "SCRY_AGENT_LAB_TOOL_RESULT_PROJECTION "
            "must be 'full' or 'structured'"
        )

    structured = payload.get(
        "structuredContent"
    )
    content = payload.get("content")

    if (
        structured is None
        or not isinstance(content, list)
        or len(content) != 1
    ):
        return payload

    block = content[0]

    if (
        not isinstance(block, dict)
        or block.get("type") != "text"
        or not isinstance(
            block.get("text"),
            str,
        )
    ):
        return payload

    try:
        parsed = json.loads(
            block["text"]
        )
    except Exception:
        return payload

    if parsed != structured:
        return payload

    projected = dict(payload)
    projected.pop("content", None)

    return projected


def _rejection(payload: dict[str, Any]) -> dict[str, Any] | None:
    structured = payload.get("structuredContent")
    if not isinstance(structured, dict):
        return None
    rejection = structured.get("rejection")
    return rejection if isinstance(rejection, dict) else None


def _observation_tool(name: str) -> bool:
    return name.startswith(("get_", "list_", "observe_", "search_")) or any(
        marker in name
        for marker in ("_get_", "_list_", "_observe_", "_search_")
    )


def _safe_actions(payload: dict[str, Any]) -> list[str]:
    rejection = _rejection(payload)
    if rejection is None:
        return []
    actions = rejection.get("safeActions")
    if not isinstance(actions, list):
        return []
    return [value for value in actions if isinstance(value, str)]


def _find_string(value: Any, names: set[str]) -> str | None:
    if isinstance(value, dict):
        for name, candidate in value.items():
            if name in names and isinstance(candidate, str):
                return candidate
        for candidate in value.values():
            found = _find_string(candidate, names)
            if found is not None:
                return found
    elif isinstance(value, list):
        for candidate in value:
            found = _find_string(candidate, names)
            if found is not None:
                return found
    return None


def _structured_blocker(
    payload: dict[str, Any],
) -> dict[str, Any] | None:
    structured = payload.get("structuredContent")
    if not isinstance(structured, dict):
        return None
    continuation = structured.get("continuation")
    if isinstance(continuation, dict):
        code = continuation.get("blockerCode")
        if isinstance(code, str):
            actions = continuation.get("safeActions")
            return {
                "code": code,
                "userAuthorityRequired": bool(
                    continuation.get("userAuthorityRequired")
                ),
                "safeActions": (
                    [
                        value
                        for value in actions
                        if isinstance(value, str)
                    ]
                    if isinstance(actions, list)
                    else []
                ),
            }
    rejection = structured.get("rejection")
    if isinstance(rejection, dict):
        code = rejection.get("code")
        if isinstance(code, str) and (
            rejection.get("userAuthorityRequired") is True
            or "AUTHORITY" in code.upper()
            or "SELECTION_REQUIRED" in code.upper()
            or "RECONCILIATION_REQUIRED" in code.upper()
        ):
            actions = rejection.get("safeActions")
            return {
                "code": code,
                "userAuthorityRequired": bool(
                    rejection.get("userAuthorityRequired")
                    or "AUTHORITY" in code.upper()
                    or "SELECTION_REQUIRED" in code.upper()
                ),
                "safeActions": (
                    [
                        value
                        for value in actions
                        if isinstance(value, str)
                    ]
                    if isinstance(actions, list)
                    else []
                ),
            }
    return None


def _mission_completion_evidence(
    tool_name: str,
    payload: dict[str, Any],
    arguments: dict[str, Any],
    spec: AgentRunSpec,
    lifecycle: dict[str, Any],
) -> dict[str, Any] | None:
    if tool_name not in {
        "publish_mission_report",
        "browser_v2_publish_mission_report",
    } or payload.get("isError"):
        return None
    structured = payload.get("structuredContent")
    if not isinstance(structured, dict):
        return None
    if tool_name == "browser_v2_publish_mission_report":
        report_id = structured.get("reportId")
        mission_id = arguments.get("missionId")
        if isinstance(report_id, str) and isinstance(mission_id, str):
            return {
                "kind": "mission_report",
                "missionId": mission_id,
                "reportId": report_id,
                "reportStatus": "published",
            }
        return None
    report = structured.get("report")
    if not isinstance(report, dict):
        return None
    report_id = report.get("id")
    mission_id = report.get("missionId")
    if spec.expected_attempt_id is None:
        if (
            isinstance(report_id, str)
            and isinstance(mission_id, str)
            and report.get("status") == "published"
        ):
            return {
                "kind": "mission_report",
                "missionId": mission_id,
                "reportId": report_id,
                "reportStatus": "published",
            }
        return None
    if (
        not isinstance(report_id, str)
        or not isinstance(mission_id, str)
        or report.get("status") != "published"
        or mission_id != spec.expected_mission_id
        or arguments.get("missionId") != spec.expected_mission_id
        or arguments.get("agentSessionId")
        != spec.expected_agent_session_id
        or lifecycle.get("campaignId")
        != spec.expected_campaign_id
        or lifecycle.get("runId") is None
        or lifecycle.get("runFinalized") is not True
        or lifecycle.get("evidenceAccepted") is not True
    ):
        return None
    return {
        "kind": "mission_report",
        "missionId": mission_id,
        "reportId": report_id,
        "reportStatus": "published",
        "attemptId": spec.expected_attempt_id,
        "campaignId": spec.expected_campaign_id,
        "objectiveId": spec.expected_objective_id,
        "runId": lifecycle["runId"],
        "agentSessionId": spec.expected_agent_session_id,
    }


async def run_agent(
    *,
    spec: AgentRunSpec,
    model: Any,
    mcp: Any,
    transcript: Transcript,
    model_name: str,
    provider_name: str,
) -> AgentRunResult:
    started = time.perf_counter()
    snapshot = await mcp.snapshot()
    digest = instructions_digest(snapshot)

    transcript.write(
        "mcp_snapshot",
        {
            "serverInfo": snapshot.server_info,
            "protocolVersion": snapshot.protocol_version,
            "instructions": snapshot.instructions,
            "instructionsDigest": digest,
            "runtimeIdentity": snapshot.runtime_identity,
            "tools": [
                tool.model_dump(mode="json")
                for tool in snapshot.tools
            ],
        },
    )

    system = SYSTEM_PROMPT

    if snapshot.instructions:
        system += (
            "\n\nThe MCP server supplied these instructions:\n\n"
            + snapshot.instructions
        )

    messages: list[dict[str, Any]] = [
        {
            "role": "system",
            "content": system,
        },
        {
            "role": "user",
            "content": spec.objective,
        },
    ]

    tools = model_tools(snapshot)
    tool_call_count = 0
    invalid_calls = 0
    stale_reference_calls = 0
    repeated_unchanged_observations = 0
    unnecessary_capabilities_calls = 0
    observation_digests: dict[str, str] = {}
    model_inference_ms = 0
    mcp_execution_ms = 0
    time_to_first_mcp_call_ms: int | None = None
    time_to_first_observation_ms: int | None = None
    time_to_first_valid_dispatch_ms: int | None = None
    praxis_startup_ms: int | None = None
    acquisition_ms = 0
    dispatch_ms = 0
    successor_observation_ms = 0
    evidence_finalization_ms = 0
    report_composition_ms = 0
    unresolved_blocker: dict[str, Any] | None = None
    completion_evidence: dict[str, Any] | None = None
    exact_lifecycle: dict[str, Any] = {
        "campaignId": spec.expected_campaign_id,
        "runId": None,
        "runFinalized": False,
        "evidenceAccepted": False,
    }
    capabilities_directed = any(
        term in spec.objective.lower()
        for term in ("capability", "compatibility", "release")
    )
    max_turns = int(spec.max_turns or 0)
    max_tool_calls = int(spec.max_tool_calls or 0)
    max_wall_time_seconds = int(spec.max_wall_time_seconds or 0)
    deadline = started + max_wall_time_seconds

    async def finish(
        *,
        status: str,
        turns: int,
        completed: bool,
        failure: str | None = None,
        final_response: str | None = None,
        termination_category: str = "unknown",
        terminal_outcome: str,
        termination_reason_code: str,
    ) -> AgentRunResult:
        settlement = None
        if hasattr(mcp, "terminate"):
            try:
                settlement = await mcp.terminate(
                    termination_reason_code,
                    (
                        str(unresolved_blocker["code"])
                        if unresolved_blocker
                        else None
                    ),
                    terminal_outcome,
                )
            except Exception as error:
                settlement = {
                    "settled": False,
                    "reasonCode": "LIFECYCLE_SETTLEMENT_UNAVAILABLE",
                    "errorClass": type(error).__name__,
                }
            transcript.write(
                "lifecycle_settlement",
                {
                    "failure": failure,
                    "result": settlement,
                },
            )
        return AgentRunResult(
            status=status,
            objective=spec.objective,
            provider=provider_name,
            model=model_name,
            mcp_url=spec.mcp_url,
            mcp_protocol_version=snapshot.protocol_version,
            mcp_server_info=snapshot.server_info,
            instructions_digest=digest,
            advertised_tools=[tool.name for tool in snapshot.tools],
            budget_profile=spec.profile,
            budget_limits={
                "maxTurns": max_turns,
                "maxToolCalls": max_tool_calls,
                "maxWallTimeSeconds": max_wall_time_seconds,
            },
            runtime_identity=snapshot.runtime_identity,
            external_run_id=spec.external_run_id,
            experiment_id=spec.experiment_id,
            turns=turns,
            tool_calls=tool_call_count,
            invalid_calls=invalid_calls,
            stale_reference_calls=stale_reference_calls,
            repeated_unchanged_observations=(
                repeated_unchanged_observations
            ),
            unnecessary_capabilities_calls=(
                unnecessary_capabilities_calls
            ),
            completed=completed,
            duration_ms=int((time.perf_counter() - started) * 1000),
            latency={
                "timeToFirstMcpCallMs": time_to_first_mcp_call_ms,
                "timeToFirstObservationMs": time_to_first_observation_ms,
                "timeToFirstValidDispatchMs": (
                    time_to_first_valid_dispatch_ms
                ),
                "modelInferenceMs": model_inference_ms,
                "mcpExecutionMs": mcp_execution_ms,
                "praxisStartupMs": praxis_startup_ms,
                "acquisitionMs": acquisition_ms,
                "dispatchMs": dispatch_ms,
                "successorObservationMs": successor_observation_ms,
                "evidenceFinalizationMs": evidence_finalization_ms,
                "reportCompositionMs": report_composition_ms,
                "totalJourneyMs": int(
                    (time.perf_counter() - started) * 1000
                ),
            },
            final_response=final_response,
            transcript_path=str(transcript.path),
            failure=failure,
            terminal_outcome=terminal_outcome,
            terminal_blocker=unresolved_blocker,
            completion_evidence=completion_evidence,
            termination_category=termination_category,
            lifecycle_settlement=settlement,
        )

    for turn in range(1, max_turns + 1):
        transcript.write(
            "model_request",
            {
                "turn": turn,
                "messageCount": len(messages),
                "toolCount": len(tools),
            },
        )

        remaining = deadline - time.perf_counter()
        if remaining <= 0:
            return await finish(
                status="limit_exceeded",
                turns=turn - 1,
                completed=False,
                failure="MAX_WALL_TIME_EXCEEDED",
                termination_category="harness_limit",
                terminal_outcome="limit_exceeded",
                termination_reason_code="MAX_WALL_TIME_EXCEEDED",
            )
        model_started = time.perf_counter()
        try:
            if hasattr(mcp, "record_provider_request"):
                await mcp.record_provider_request()
            response = await asyncio.wait_for(
                model.complete(messages, tools),
                timeout=remaining,
            )
            model_inference_ms += int(
                (time.perf_counter() - model_started) * 1000
            )
        except asyncio.CancelledError:
            model_inference_ms += int(
                (time.perf_counter() - model_started) * 1000
            )
            return await finish(
                status="cancelled",
                turns=turn,
                completed=False,
                failure="EXTERNAL_AGENT_HARNESS_CANCELLED",
                termination_category="cancelled",
                terminal_outcome="cancelled",
                termination_reason_code=(
                    "EXTERNAL_AGENT_HARNESS_CANCELLED"
                ),
            )
        except asyncio.TimeoutError:
            model_inference_ms += int(
                (time.perf_counter() - model_started) * 1000
            )
            return await finish(
                status="limit_exceeded",
                turns=turn,
                completed=False,
                failure="MAX_WALL_TIME_EXCEEDED",
                termination_category="harness_limit",
                terminal_outcome="limit_exceeded",
                termination_reason_code="MAX_WALL_TIME_EXCEEDED",
            )
        except Exception as error:
            model_inference_ms += int(
                (time.perf_counter() - model_started) * 1000
            )
            transcript.write(
                "model_error",
                {"turn": turn, "errorClass": type(error).__name__},
            )
            return await finish(
                status="failed",
                turns=turn,
                completed=False,
                failure="MODEL_PROVIDER_ERROR",
                termination_category="provider_error",
                terminal_outcome="provider_failure",
                termination_reason_code="MODEL_PROVIDER_ERROR",
            )

        transcript.write(
            "model_response",
            {
                "turn": turn,
                "content": response.content,
                "toolCalls": [
                    {
                        "id": call.id,
                        "name": call.name,
                        "arguments": call.arguments,
                    }
                    for call in response.tool_calls
                ],
                "usage": response.usage,
                "finishReason": getattr(
                    response,
                    "finish_reason",
                    None,
                ),
            },
        )

        assistant_message: dict[str, Any] = {
            "role": "assistant",
            "content": response.content or "",
        }

        if response.tool_calls:
            assistant_message["tool_calls"] = [
                {
                    "id": call.id,
                    "type": "function",
                    "function": {
                        "name": call.name,
                        "arguments": call.arguments,
                    },
                }
                for call in response.tool_calls
            ]

        messages.append(assistant_message)

        if not response.tool_calls:
            if completion_evidence is not None:
                return await finish(
                    status="completed",
                    turns=turn,
                    completed=True,
                    final_response=response.content,
                    termination_category="completed",
                    terminal_outcome="objective_completed",
                    termination_reason_code=(
                        "EXTERNAL_AGENT_OBJECTIVE_COMPLETED"
                    ),
                )
            if unresolved_blocker is not None:
                user_authority = bool(
                    unresolved_blocker.get(
                        "userAuthorityRequired"
                    )
                )
                return await finish(
                    status="blocked",
                    turns=turn,
                    completed=False,
                    final_response=response.content,
                    failure=str(unresolved_blocker["code"]),
                    termination_category="blocked",
                    terminal_outcome=(
                        "blocked_user_authority"
                        if user_authority
                        else "blocked_system"
                    ),
                    termination_reason_code=(
                        "EXTERNAL_AGENT_BLOCKED_USER_AUTHORITY"
                        if user_authority
                        else "EXTERNAL_AGENT_BLOCKED_SYSTEM"
                    ),
                )
            return await finish(
                status="stopped",
                turns=turn,
                completed=False,
                final_response=response.content,
                termination_category="model_stopped",
                terminal_outcome=(
                    "model_stopped_without_completion"
                ),
                termination_reason_code=(
                    "EXTERNAL_AGENT_MODEL_STOPPED_WITHOUT_COMPLETION"
                ),
            )

        for call in response.tool_calls:
            if tool_call_count >= max_tool_calls:
                return await finish(
                    status="limit_exceeded",
                    turns=turn,
                    completed=False,
                    failure="MAX_TOOL_CALLS_EXCEEDED",
                    termination_category="harness_limit",
                    terminal_outcome="limit_exceeded",
                    termination_reason_code="MAX_TOOL_CALLS_EXCEEDED",
                )

            tool_call_count += 1

            if call.name == "get_capabilities" and not capabilities_directed:
                unnecessary_capabilities_calls += 1

            try:
                parsed = json.loads(call.arguments or "{}")
                if not isinstance(parsed, dict):
                    raise ValueError(
                        "Tool arguments must be a JSON object."
                    )
            except Exception as error:
                invalid_calls += 1
                tool_payload = {
                    "isError": True,
                    "content": [
                        {
                            "type": "text",
                            "text": (
                                "INVALID_TOOL_ARGUMENTS: "
                                + str(error)
                            ),
                        }
                    ],
                    "structuredContent": None,
                }

                transcript.write(
                    "tool_argument_error",
                    {
                        "turn": turn,
                        "toolCallId": call.id,
                        "tool": call.name,
                        "arguments": call.arguments,
                        "error": str(error),
                    },
                )
            else:
                transcript.write(
                    "tool_call",
                    {
                        "turn": turn,
                        "toolCallId": call.id,
                        "tool": call.name,
                        "arguments": parsed,
                    },
                )

                tool_started = time.perf_counter()
                if time_to_first_mcp_call_ms is None:
                    time_to_first_mcp_call_ms = int(
                        (tool_started - started) * 1000
                    )
                remaining = deadline - time.perf_counter()
                if remaining <= 0:
                    return await finish(
                        status="limit_exceeded",
                        turns=turn,
                        completed=False,
                        failure="MAX_WALL_TIME_EXCEEDED",
                        termination_category="harness_limit",
                        terminal_outcome="limit_exceeded",
                        termination_reason_code="MAX_WALL_TIME_EXCEEDED",
                    )
                try:
                    result = await asyncio.wait_for(
                        mcp.call_tool(call.name, parsed),
                        timeout=remaining,
                    )
                except asyncio.CancelledError:
                    return await finish(
                        status="cancelled",
                        turns=turn,
                        completed=False,
                        failure=(
                            "EXTERNAL_AGENT_HARNESS_CANCELLED"
                        ),
                        termination_category="cancelled",
                        terminal_outcome="cancelled",
                        termination_reason_code=(
                            "EXTERNAL_AGENT_HARNESS_CANCELLED"
                        ),
                    )
                except asyncio.TimeoutError:
                    return await finish(
                        status="limit_exceeded",
                        turns=turn,
                        completed=False,
                        failure="MAX_WALL_TIME_EXCEEDED",
                        termination_category="harness_limit",
                        terminal_outcome="limit_exceeded",
                        termination_reason_code="MAX_WALL_TIME_EXCEEDED",
                    )
                except Exception as error:
                    transcript.write(
                        "mcp_error",
                        {
                            "turn": turn,
                            "toolCallId": call.id,
                            "tool": call.name,
                            "errorClass": type(error).__name__,
                        },
                    )
                    return await finish(
                        status="failed",
                        turns=turn,
                        completed=False,
                        failure="MCP_TOOL_TRANSPORT_ERROR",
                        termination_category="mcp_error",
                        terminal_outcome="blocked_system",
                        termination_reason_code=(
                            "MCP_TOOL_TRANSPORT_ERROR"
                        ),
                    )
                tool_payload = result.for_model()
                tool_duration_ms = int(
                    (time.perf_counter() - tool_started) * 1000
                )
                mcp_execution_ms += tool_duration_ms
                if _observation_tool(call.name) and time_to_first_observation_ms is None:
                    time_to_first_observation_ms = int(
                        (time.perf_counter() - started) * 1000
                    )
                if call.name == "start_praxis_session" and praxis_startup_ms is None:
                    praxis_startup_ms = tool_duration_ms
                if call.name in {
                    "list_project_credentials",
                    "create_project_credential",
                    "authorize_environment_credentials",
                }:
                    acquisition_ms += tool_duration_ms
                if call.name == "dispatch_run_operation":
                    dispatch_ms += tool_duration_ms
                    if not tool_payload.get("isError"):
                        if time_to_first_valid_dispatch_ms is None:
                            time_to_first_valid_dispatch_ms = int(
                                (time.perf_counter() - started) * 1000
                            )
                        structured = tool_payload.get("structuredContent")
                        if (
                            isinstance(structured, dict)
                            and isinstance(structured.get("result"), dict)
                            and structured["result"].get("successorObservation")
                        ):
                            successor_observation_ms += tool_duration_ms
                if call.name in {
                    "finalize_run",
                    "accept_objective_evidence",
                }:
                    evidence_finalization_ms += tool_duration_ms
                if call.name in {
                    "preview_mission_report",
                    "publish_mission_report",
                    "browser_v2_publish_mission_report",
                }:
                    report_composition_ms += tool_duration_ms

                rejection = _rejection(tool_payload)
                if rejection is not None:
                    rejection_class = rejection.get("rejectionClass")
                    code = str(rejection.get("code", "")).upper()
                    if rejection_class == "invalid_input":
                        invalid_calls += 1
                    if rejection_class == "stale_authority" or any(
                        marker in code
                        for marker in (
                            "STALE",
                            "REFERENCE",
                            "DOCUMENT_CHANGED",
                        )
                    ):
                        stale_reference_calls += 1

                blocker = _structured_blocker(tool_payload)
                if call.name == "get_operating_context":
                    unresolved_blocker = blocker
                elif blocker is not None:
                    unresolved_blocker = blocker
                elif (
                    not tool_payload.get("isError")
                    and call.name
                    in {
                        "start_mission",
                        "prepare_flow_authoring",
                        "resume_mission",
                    }
                ):
                    unresolved_blocker = None

                if not tool_payload.get("isError"):
                    if (
                        call.name == "start_run"
                        and parsed.get(
                            "qualificationCampaignAuthorizationId"
                        ) == spec.expected_campaign_id
                    ):
                        exact_lifecycle["runId"] = _find_string(
                            tool_payload,
                            {"runId", "id"},
                        )
                    elif (
                        call.name == "finalize_run"
                        and parsed.get("runId")
                        == exact_lifecycle.get("runId")
                    ):
                        exact_lifecycle["runFinalized"] = True
                    elif (
                        call.name == "accept_objective_evidence"
                        and parsed.get("objectiveId")
                        == spec.expected_objective_id
                        and parsed.get("runId")
                        == exact_lifecycle.get("runId")
                        and parsed.get("missionId")
                        == spec.expected_mission_id
                    ):
                        exact_lifecycle["evidenceAccepted"] = True

                proven_completion = _mission_completion_evidence(
                    call.name,
                    tool_payload,
                    parsed,
                    spec,
                    exact_lifecycle,
                )
                if proven_completion is not None:
                    completion_evidence = proven_completion
                    unresolved_blocker = None

                if _observation_tool(call.name):
                    digest_value = hashlib.sha256(
                        json.dumps(
                            tool_payload,
                            sort_keys=True,
                            ensure_ascii=False,
                            default=str,
                        ).encode("utf-8")
                    ).hexdigest()
                    if observation_digests.get(call.name) == digest_value:
                        repeated_unchanged_observations += 1
                    observation_digests[call.name] = digest_value

                capabilities_directed = capabilities_directed or any(
                    action in {
                        "get_capabilities",
                        "verify_api_release",
                        "restart_mcp_with_current_release",
                    }
                    for action in _safe_actions(tool_payload)
                )

                transcript.write(
                    "tool_result",
                    {
                        "turn": turn,
                        "toolCallId": call.id,
                        "tool": call.name,
                        "durationMs": tool_duration_ms,
                        "result": tool_payload,
                    },
                )

            messages.append(
                {
                    "role": "tool",
                    "tool_call_id": call.id,
                    "content": json.dumps(
                        _model_tool_payload(
                            tool_payload
                        ),
                        ensure_ascii=False,
                        default=str,
                    ),
                }
            )

    return await finish(
        status="limit_exceeded",
        turns=max_turns,
        completed=False,
        failure="MAX_TURNS_EXCEEDED",
        termination_category="harness_limit",
        terminal_outcome="limit_exceeded",
        termination_reason_code="MAX_TURNS_EXCEEDED",
    )
