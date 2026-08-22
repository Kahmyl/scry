from __future__ import annotations

from contextlib import AsyncExitStack
from typing import Any

import httpx2
from mcp import Client
from mcp.client.streamable_http import streamable_http_client

from .types import McpSnapshot, McpTool, McpToolResult


def _dump(value: Any) -> Any:
    if value is None:
        return None
    if hasattr(value, "model_dump"):
        return value.model_dump(
            mode="json",
            by_alias=True,
            exclude_none=True,
        )
    return value


class ScryMcpClient:
    def __init__(self, url: str, token: str) -> None:
        self.url = url
        self.token = token
        self._stack: AsyncExitStack | None = None
        self._client: Client | None = None

    async def __aenter__(self) -> "ScryMcpClient":
        stack = AsyncExitStack()

        http_client = await stack.enter_async_context(
            httpx2.AsyncClient(
                headers={"Authorization": f"Bearer {self.token}"},
                timeout=httpx2.Timeout(30.0, read=300.0),
                follow_redirects=True,
            )
        )

        transport = streamable_http_client(
            self.url,
            http_client=http_client,
        )

        self._client = await stack.enter_async_context(
            Client(transport)
        )
        self._stack = stack
        return self

    async def __aexit__(self, exc_type, exc, tb) -> None:
        if self._stack is not None:
            await self._stack.aclose()

    def _require_client(self) -> Client:
        if self._client is None:
            raise RuntimeError("MCP_CLIENT_NOT_CONNECTED")
        return self._client

    async def snapshot(self) -> McpSnapshot:
        client = self._require_client()

        tools: list[McpTool] = []
        cursor: str | None = None

        while True:
            listed = await client.list_tools(cursor=cursor)

            tools.extend(
                McpTool(
                    name=tool.name,
                    description=tool.description,
                    input_schema=tool.input_schema,
                )
                for tool in listed.tools
            )

            cursor = listed.next_cursor

            if cursor is None:
                break

        server_info = _dump(client.server_info)

        return McpSnapshot(
            server_info=server_info if isinstance(server_info, dict) else None,
            protocol_version=(
                str(client.protocol_version)
                if client.protocol_version is not None
                else None
            ),
            instructions=client.instructions,
            tools=tools,
        )

    async def call_tool(
        self,
        name: str,
        arguments: dict[str, Any],
    ) -> McpToolResult:
        client = self._require_client()
        result = await client.call_tool(name, arguments)

        return McpToolResult(
            is_error=bool(result.is_error),
            structured_content=result.structured_content,
            content=[
                _dump(block)
                for block in result.content
            ],
        )
