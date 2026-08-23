from __future__ import annotations

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
    capabilities_directed = any(
        term in spec.objective.lower()
        for term in ("capability", "compatibility", "release")
    )

    for turn in range(1, spec.max_turns + 1):
        transcript.write(
            "model_request",
            {
                "turn": turn,
                "messageCount": len(messages),
                "toolCount": len(tools),
            },
        )

        response = await model.complete(messages, tools)

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
            return AgentRunResult(
                status="completed",
                objective=spec.objective,
                provider=provider_name,
                model=model_name,
                mcp_url=spec.mcp_url,
                mcp_protocol_version=snapshot.protocol_version,
                mcp_server_info=snapshot.server_info,
                instructions_digest=digest,
                advertised_tools=[
                    tool.name
                    for tool in snapshot.tools
                ],
                turns=turn,
                tool_calls=tool_call_count,
                invalid_calls=invalid_calls,
                stale_reference_calls=stale_reference_calls,
                repeated_unchanged_observations=(
                    repeated_unchanged_observations
                ),
                unnecessary_capabilities_calls=(
                    unnecessary_capabilities_calls
                ),
                completed=True,
                duration_ms=int(
                    (time.perf_counter() - started) * 1000
                ),
                final_response=response.content,
                transcript_path=str(transcript.path),
            )

        for call in response.tool_calls:
            if tool_call_count >= spec.max_tool_calls:
                return AgentRunResult(
                    status="limit_exceeded",
                    objective=spec.objective,
                    provider=provider_name,
                    model=model_name,
                    mcp_url=spec.mcp_url,
                    mcp_protocol_version=snapshot.protocol_version,
                    mcp_server_info=snapshot.server_info,
                    instructions_digest=digest,
                    advertised_tools=[
                        tool.name
                        for tool in snapshot.tools
                    ],
                    turns=turn,
                    tool_calls=tool_call_count,
                    invalid_calls=invalid_calls,
                    stale_reference_calls=stale_reference_calls,
                    repeated_unchanged_observations=(
                        repeated_unchanged_observations
                    ),
                    unnecessary_capabilities_calls=(
                        unnecessary_capabilities_calls
                    ),
                    completed=False,
                    duration_ms=int(
                        (time.perf_counter() - started) * 1000
                    ),
                    transcript_path=str(transcript.path),
                    failure="MAX_TOOL_CALLS_EXCEEDED",
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
                result = await mcp.call_tool(
                    call.name,
                    parsed,
                )
                tool_payload = result.for_model()

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
                        "durationMs": int(
                            (
                                time.perf_counter()
                                - tool_started
                            )
                            * 1000
                        ),
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

    return AgentRunResult(
        status="limit_exceeded",
        objective=spec.objective,
        provider=provider_name,
        model=model_name,
        mcp_url=spec.mcp_url,
        mcp_protocol_version=snapshot.protocol_version,
        mcp_server_info=snapshot.server_info,
        instructions_digest=digest,
        advertised_tools=[
            tool.name
            for tool in snapshot.tools
        ],
        turns=spec.max_turns,
        tool_calls=tool_call_count,
        invalid_calls=invalid_calls,
        stale_reference_calls=stale_reference_calls,
        repeated_unchanged_observations=(
            repeated_unchanged_observations
        ),
        unnecessary_capabilities_calls=(
            unnecessary_capabilities_calls
        ),
        completed=False,
        duration_ms=int(
            (time.perf_counter() - started) * 1000
        ),
        transcript_path=str(transcript.path),
        failure="MAX_TURNS_EXCEEDED",
    )
