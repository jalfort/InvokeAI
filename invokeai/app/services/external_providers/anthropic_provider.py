"""Anthropic provider — text-only (prompt optimization via Claude models)."""

import asyncio
from typing import Optional

from PIL import Image

from invokeai.app.services.external_providers.base import (
    BaseProvider,
    GenerateParams,
    ImageResult,
    ModelInfo,
    ProgressCallback,
    ProviderCapabilities,
)


class AnthropicProvider(BaseProvider):
    """Anthropic text-only provider. Used for prompt optimization, not image generation."""

    provider_id = "anthropic"
    display_name = "Anthropic"

    async def generate(
        self,
        prompt: str,
        model_id: str,
        params: GenerateParams,
        ref_images: list[Image.Image],
        api_key: str,
        progress_cb: Optional[ProgressCallback] = None,
        dynamic_images: Optional[dict[str, list[Image.Image]]] = None,
    ) -> list[ImageResult]:
        raise NotImplementedError("Anthropic provider is text-only. Image generation is not supported.")

    async def edit(
        self,
        prompt: str,
        model_id: str,
        source_images: list[Image.Image],
        params: GenerateParams,
        api_key: str,
        progress_cb: Optional[ProgressCallback] = None,
        dynamic_images: Optional[dict[str, list[Image.Image]]] = None,
    ) -> list[ImageResult]:
        raise NotImplementedError("Anthropic provider is text-only. Image editing is not supported.")

    def get_capabilities(self, model_id: str) -> ProviderCapabilities:
        return ProviderCapabilities(
            supports_refs_in_generate=False,
            supports_masks=False,
            max_refs=0,
            max_images_per_call=0,
            supported_resolutions=[],
            has_seed=False,
            has_guidance_scale=False,
            output_formats=[],
            capability_type="text",
        )

    async def test_key(self, api_key: str) -> tuple[bool, str]:
        """Validate an Anthropic API key with a minimal messages call."""
        import requests

        def _test() -> tuple[bool, str]:
            try:
                resp = requests.post(
                    "https://api.anthropic.com/v1/messages",
                    headers={
                        "x-api-key": api_key,
                        "anthropic-version": "2023-06-01",
                        "Content-Type": "application/json",
                    },
                    json={
                        "model": "claude-haiku-4-5-20251001",
                        "max_tokens": 5,
                        "messages": [{"role": "user", "content": "Reply with exactly: OK"}],
                    },
                    timeout=15,
                )
                if resp.status_code == 200:
                    return (True, "API key is valid.")
                if resp.status_code in (401, 403):
                    return (False, "API key is invalid or expired.")
                return (False, f"Unexpected response: {resp.status_code}")
            except Exception as e:
                return (False, f"Could not verify key: {e}")

        return await asyncio.to_thread(_test)

    def get_supported_models(self) -> list[ModelInfo]:
        return []
