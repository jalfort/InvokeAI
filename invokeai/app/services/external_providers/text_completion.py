"""Lightweight text completion wrappers for external LLM providers.

Used for prompt optimization and system prompt refinement — no image generation.
Each provider uses the cheapest/fastest model by default.
"""

import asyncio
import json
import logging
from typing import Optional

import requests

logger = logging.getLogger("InvokeAI")

# Default (cheap/fast) models per provider
DEFAULT_MODELS: dict[str, str] = {
    "gemini": "gemini-2.0-flash",
    "openai": "gpt-4o-mini",
    "anthropic": "claude-sonnet-4-6-20250514",
    "openrouter": "anthropic/claude-sonnet-4-6-20250514",
}

# Providers that support text completion
TEXT_CAPABLE_PROVIDERS = set(DEFAULT_MODELS.keys())


async def complete_text(
    provider: str,
    api_key: str,
    system_prompt: str,
    user_prompt: str,
    model: Optional[str] = None,
) -> tuple[str, str]:
    """Route to the correct provider's chat completion API.

    Args:
        provider: Provider identifier (gemini, openai, anthropic, openrouter).
        api_key: API key for the provider.
        system_prompt: System instruction for the LLM.
        user_prompt: User message to send.
        model: Override the default model. If None, uses DEFAULT_MODELS.

    Returns:
        Tuple of (response_text, model_used).

    Raises:
        ValueError: If the provider is not supported for text completion.
        RuntimeError: If the API call fails.
    """
    if provider not in TEXT_CAPABLE_PROVIDERS:
        raise ValueError(f"Provider '{provider}' does not support text completion. Supported: {TEXT_CAPABLE_PROVIDERS}")

    resolved_model = model or DEFAULT_MODELS[provider]

    if provider == "gemini":
        text = await _complete_gemini(api_key, system_prompt, user_prompt, resolved_model)
    elif provider == "openai":
        text = await _complete_openai(api_key, system_prompt, user_prompt, resolved_model)
    elif provider == "anthropic":
        text = await _complete_anthropic(api_key, system_prompt, user_prompt, resolved_model)
    elif provider == "openrouter":
        text = await _complete_openai(
            api_key,
            system_prompt,
            user_prompt,
            resolved_model,
            base_url="https://openrouter.ai/api/v1",
        )
    else:
        raise ValueError(f"Unknown provider: {provider}")

    return (text, resolved_model)


async def _complete_gemini(api_key: str, system_prompt: str, user_prompt: str, model: str) -> str:
    """Text completion via Google Gemini (google-genai SDK)."""
    from google import genai
    from google.genai import types

    client = genai.Client(api_key=api_key)
    config = types.GenerateContentConfig(
        system_instruction=system_prompt,
    )
    response = await client.aio.models.generate_content(
        model=model,
        contents=user_prompt,
        config=config,
    )
    if not response or not response.text:
        raise RuntimeError("Gemini returned no text response.")
    return response.text


async def _complete_openai(
    api_key: str,
    system_prompt: str,
    user_prompt: str,
    model: str,
    base_url: str = "https://api.openai.com/v1",
) -> str:
    """Text completion via OpenAI-compatible API (also used for OpenRouter)."""

    def _call() -> str:
        resp = requests.post(
            f"{base_url}/chat/completions",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json={
                "model": model,
                "messages": [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt},
                ],
                "max_tokens": 2048,
            },
            timeout=60,
        )
        resp.raise_for_status()
        data = resp.json()
        choices = data.get("choices", [])
        if not choices:
            raise RuntimeError(f"No choices in response: {json.dumps(data)[:300]}")
        return choices[0]["message"]["content"]

    return await asyncio.to_thread(_call)


async def _complete_anthropic(api_key: str, system_prompt: str, user_prompt: str, model: str) -> str:
    """Text completion via Anthropic Messages API."""

    def _call() -> str:
        resp = requests.post(
            "https://api.anthropic.com/v1/messages",
            headers={
                "x-api-key": api_key,
                "anthropic-version": "2023-06-01",
                "Content-Type": "application/json",
            },
            json={
                "model": model,
                "max_tokens": 2048,
                "system": system_prompt,
                "messages": [
                    {"role": "user", "content": user_prompt},
                ],
            },
            timeout=60,
        )
        resp.raise_for_status()
        data = resp.json()
        content_blocks = data.get("content", [])
        if not content_blocks:
            raise RuntimeError(f"No content in response: {json.dumps(data)[:300]}")
        return content_blocks[0]["text"]

    return await asyncio.to_thread(_call)
