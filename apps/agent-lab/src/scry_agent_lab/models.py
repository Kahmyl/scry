from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from openai import AsyncOpenAI

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


class OpenAICompatibleModel:
    def __init__(self, config: ModelConfig) -> None:
        self.config = config
        self.client = AsyncOpenAI(
            base_url=config.base_url,
            api_key=config.api_key,
            timeout=120.0,
            max_retries=1,
        )

    async def complete(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
    ) -> ModelResponse:
        response = await self.client.chat.completions.create(
            model=self.config.model,
            messages=messages,
            tools=tools,
            tool_choice="auto",
            temperature=self.config.temperature,
            seed=self.config.seed,
            max_tokens=self.config.max_tokens,
        )

        message = response.choices[0].message

        tool_calls = [
            ModelToolCall(
                id=call.id,
                name=call.function.name,
                arguments=call.function.arguments,
            )
            for call in (message.tool_calls or [])
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
        )
