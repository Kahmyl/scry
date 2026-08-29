from __future__ import annotations

import asyncio
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
    def __init__(
        self,
        url: str,
        token: str,
        *,
        provider: str = "unknown",
        model: str | None = None,
        external_run_id: str | None = None,
        experiment_id: str | None = None,
        correlation_id: str | None = None,
    ) -> None:
        self.url = url
        self.token = token
        self._stack: AsyncExitStack | None = None
        self._client: Client | None = None
        self._http_client: Any | None = None
        self._heartbeat_task: asyncio.Task[None] | None = None
        self.external_run_id = external_run_id
        self.experiment_id = experiment_id
        self._identity_headers = {
            "x-scry-agent-provider": provider,
            **({"x-scry-agent-model": model} if model else {}),
            **(
                {"x-scry-external-run-id": external_run_id}
                if external_run_id
                else {}
            ),
            **(
                {"x-scry-experiment-id": experiment_id}
                if experiment_id
                else {}
            ),
            **(
                {"x-correlation-id": correlation_id}
                if correlation_id
                else {}
            ),
        }

    async def __aenter__(self) -> "ScryMcpClient":
        stack = AsyncExitStack()

        http_client = await stack.enter_async_context(
            httpx2.AsyncClient(
                headers={
                    "Authorization": f"Bearer {self.token}",
                    **self._identity_headers,
                },
                timeout=httpx2.Timeout(30.0, read=300.0),
                follow_redirects=True,
            )
        )
        self._http_client = http_client

        transport = streamable_http_client(
            self.url,
            http_client=http_client,
        )

        self._client = await stack.enter_async_context(
            Client(transport)
        )
        self._stack = stack
        if self.external_run_id:
            self._heartbeat_task = asyncio.create_task(
                self._heartbeat_loop()
            )
        return self

    async def __aexit__(self, exc_type, exc, tb) -> None:
        if self._heartbeat_task is not None:
            self._heartbeat_task.cancel()
            try:
                await self._heartbeat_task
            except asyncio.CancelledError:
                pass
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
        runtime_identity = await self.runtime_identity()

        return McpSnapshot(
            server_info=server_info if isinstance(server_info, dict) else None,
            protocol_version=(
                str(client.protocol_version)
                if client.protocol_version is not None
                else None
            ),
            instructions=client.instructions,
            tools=tools,
            runtime_identity=runtime_identity,
        )

    async def runtime_identity(self) -> dict[str, Any] | None:
        if self._http_client is None:
            return None
        try:
            response = await self._http_client.get(self._control_url("/health"))
            payload = response.json()
            if not response.is_success or not isinstance(payload, dict):
                return None
            api = payload.get("api")
            return api if isinstance(api, dict) else None
        except Exception:
            return None

    async def terminate(
        self,
        reason_code: str,
        blocker_code: str | None = None,
        terminal_outcome: str | None = None,
    ) -> dict[str, Any] | None:
        if self._http_client is None or not self.external_run_id:
            return None
        try:
            response = await self._http_client.post(
                self._control_url("/agent-lab/terminate"),
                json={
                    "reasonCode": reason_code,
                    **(
                        {"blockerCode": blocker_code}
                        if blocker_code
                        else {}
                    ),
                    **(
                        {"terminalOutcome": terminal_outcome}
                        if terminal_outcome
                        else {}
                    ),
                },
            )
            payload = response.json()
            return payload if isinstance(payload, dict) else None
        except Exception as error:
            return {
                "settled": False,
                "reasonCode": "LIFECYCLE_SETTLEMENT_UNAVAILABLE",
                "errorClass": type(error).__name__,
            }

    async def record_provider_request(self) -> None:
        if self._http_client is None or not self.external_run_id:
            raise RuntimeError("Q5_PROVIDER_REQUEST_ACCOUNTING_UNAVAILABLE")
        response = await self._http_client.post(
            self._control_url("/agent-lab/provider-request")
        )
        if not response.is_success:
            raise RuntimeError("Q5_PROVIDER_REQUEST_ACCOUNTING_REFUSED")

    async def _heartbeat_loop(self) -> None:
        while True:
            await asyncio.sleep(30)
            if self._http_client is None:
                return
            try:
                await self._http_client.post(
                    self._control_url("/agent-lab/heartbeat")
                )
            except Exception:
                # Lease expiry is API-owned and remains the recovery fallback.
                pass

    def _control_url(self, path: str) -> str:
        return self.url.rsplit("/", 1)[0] + path

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
