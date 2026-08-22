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


async def run_agent(
    *,
    spec: AgentRunSpec,
    model: Any,
    mcp: Any,
    transcript: Transcript,
    model_name: str,
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
                    duration_ms=int(
                        (time.perf_counter() - started) * 1000
                    ),
                    transcript_path=str(transcript.path),
                    failure="MAX_TOOL_CALLS_EXCEEDED",
                )

            tool_call_count += 1

            try:
                parsed = json.loads(call.arguments or "{}")
                if not isinstance(parsed, dict):
                    raise ValueError(
                        "Tool arguments must be a JSON object."
                    )
            except Exception as error:
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
        duration_ms=int(
            (time.perf_counter() - started) * 1000
        ),
        transcript_path=str(transcript.path),
        failure="MAX_TURNS_EXCEEDED",
    )
