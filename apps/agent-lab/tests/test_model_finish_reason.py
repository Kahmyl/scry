from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from scry_agent_lab.config import ModelConfig
from scry_agent_lab.models import (
    OpenAICompatibleModel,
)


@pytest.mark.asyncio
async def test_preserves_provider_finish_reason() -> None:
    config = ModelConfig(
        provider="test",
        model="test-model",
        base_url="http://127.0.0.1:1/v1",
        api_key="test",
        temperature=None,
        seed=None,
        max_tokens=32,
    )

    model = OpenAICompatibleModel(
        config
    )

    create = AsyncMock(
        return_value=SimpleNamespace(
            choices=[
                SimpleNamespace(
                    finish_reason="length",
                    message=SimpleNamespace(
                        content="partial",
                        tool_calls=[],
                    ),
                )
            ],
            usage=None,
        )
    )

    model.client = SimpleNamespace(
        chat=SimpleNamespace(
            completions=SimpleNamespace(
                create=create,
            )
        )
    )

    result = await model.complete(
        [
            {
                "role": "user",
                "content": "test",
            }
        ],
        [],
    )

    assert result.finish_reason == "length"
    assert result.content == "partial"
    assert result.tool_calls == []
