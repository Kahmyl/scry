from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import asyncio

from openai import (
    APIConnectionError,
    APITimeoutError,
    AsyncOpenAI,
    InternalServerError,
    RateLimitError,
)

from .config import ModelConfig


@dataclass(frozen=True)
class ModelToolCall:
    id: str
    name: str
    arguments: str


@dataclass(frozen=True)
class ModelResponse:
    content: str | None
    tool_calls: list[ModelToolCall]
    usage: dict[str, Any] | None
    finish_reason: str | None = None


class OpenAICompatibleModel:
    def __init__(
        self,
        config: ModelConfig,
    ) -> None:
        self.config = config
        self.client = AsyncOpenAI(
            base_url=config.base_url,
            api_key=config.api_key,
            timeout=120.0,
            max_retries=0,
        )

    async def complete(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
    ) -> ModelResponse:
        request: dict[str, Any] = {
            "model": self.config.model,
            "messages": messages,
            "tools": tools,
            "tool_choice": "auto",
            "max_tokens": self.config.max_tokens,
        }

        if self.config.temperature is not None:
            request["temperature"] = (
                self.config.temperature
            )

        if self.config.seed is not None:
            request["seed"] = (
                self.config.seed
            )

        if self.config.extra_body is not None:
            request["extra_body"] = (
                self.config.extra_body
            )

        response = None
        retryable = (
            APIConnectionError,
            APITimeoutError,
            InternalServerError,
            RateLimitError,
        )
        for attempt in range(3):
            try:
                response = await self.client.chat.completions.create(
                    **request
                )
                break
            except retryable:
                if attempt == 2:
                    raise
                await asyncio.sleep(0.5 * (2 ** attempt))
        if response is None:
            raise RuntimeError("MODEL_RESPONSE_UNAVAILABLE")

        message = response.choices[0].message

        tool_calls = [
            ModelToolCall(
                id=call.id,
                name=call.function.name,
                arguments=call.function.arguments,
            )
            for call in (
                message.tool_calls or []
            )
        ]

        usage = (
            response.usage.model_dump()
            if response.usage is not None
            else None
        )

        return ModelResponse(
            content=message.content,
            tool_calls=tool_calls,
            usage=usage,
            finish_reason=(
                response.choices[0].finish_reason
            ),
        )
