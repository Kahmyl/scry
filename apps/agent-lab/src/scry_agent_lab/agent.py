from __future__ import annotations

import asyncio
import hashlib
import json
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


def _rejection(payload: dict[str, Any]) -> dict[str, Any] | None:
    structured = payload.get("structuredContent")
    if not isinstance(structured, dict):
        return None
    rejection = structured.get("rejection")
    return rejection if isinstance(rejection, dict) else None


def _observation_tool(name: str) -> bool:
    return name.startswith(("get_", "list_", "observe_", "search_"))


def _safe_actions(payload: dict[str, Any]) -> list[str]:
    rejection = _rejection(payload)
    if rejection is None:
        return []
    actions = rejection.get("safeActions")
    if not isinstance(actions, list):
        return []
    return [value for value in actions if isinstance(value, str)]


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
    ) -> AgentRunResult:
        settlement = None
        if hasattr(mcp, "terminate"):
            try:
                settlement = await mcp.terminate(
                    failure or "EXTERNAL_AGENT_HARNESS_COMPLETED"
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
            )
        try:
            model_started = time.perf_counter()
            response = await asyncio.wait_for(
                model.complete(messages, tools),
                timeout=remaining,
            )
            model_inference_ms += int(
                (time.perf_counter() - model_started) * 1000
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
            return await finish(
                status="completed",
                turns=turn,
                completed=True,
                final_response=response.content,
                termination_category="completed",
            )

        for call in response.tool_calls:
            if tool_call_count >= max_tool_calls:
                return await finish(
                    status="limit_exceeded",
                    turns=turn,
                    completed=False,
                    failure="MAX_TOOL_CALLS_EXCEEDED",
                    termination_category="harness_limit",
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
                    )
                try:
                    result = await asyncio.wait_for(
                        mcp.call_tool(call.name, parsed),
                        timeout=remaining,
                    )
                except asyncio.TimeoutError:
                    return await finish(
                        status="limit_exceeded",
                        turns=turn,
                        completed=False,
                        failure="MAX_WALL_TIME_EXCEEDED",
                        termination_category="harness_limit",
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
                        tool_payload,
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
    )
