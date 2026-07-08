"""Google Gemini provider for external image generation.

Uses the google-genai SDK to call Gemini's native generateContent API
with IMAGE response modality. Each model has its own validated config
(resolutions, aspect ratios, response modalities) — no shared parameters.
"""

import concurrent.futures
import io
from typing import Any, Optional

from PIL import Image

from invokeai.app.services.external_providers.base import (
    BaseProvider,
    GenerateParams,
    ImageResult,
    ModelInfo,
    ProgressCallback,
    ProviderCapabilities,
)

# ──────────────────────────────────────────────────
# Per-model configurations — each model is fully isolated.
# "schema" follows JSON Schema format rendered by DynamicSchemaSettings.
# ──────────────────────────────────────────────────

_STANDARD_ASPECT_RATIOS = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"]

_MODEL_CONFIGS: dict[str, dict[str, Any]] = {
    "gemini-3.1-flash-image-preview": {
        "response_modalities": ["IMAGE"],
        "max_refs": 14,
        "schema": {
            "properties": {
                "image_size": {
                    "type": "string",
                    "title": "Resolution",
                    "enum": ["512px", "1K", "2K", "4K"],
                    "default": "1K",
                },
                "aspect_ratio": {
                    "type": "string",
                    "title": "Aspect Ratio",
                    "enum": [*_STANDARD_ASPECT_RATIOS, "1:4", "4:1", "1:8", "8:1"],
                    "default": "1:1",
                },
                "enable_web_search": {
                    "type": "boolean",
                    "title": "Web Search Grounding",
                    "default": False,
                },
            },
        },
    },
    "gemini-3-pro-image-preview": {
        "response_modalities": None,  # Omit — let Pro auto-decide (handles text+image natively)
        "max_refs": 11,
        "schema": {
            "properties": {
                "image_size": {
                    "type": "string",
                    "title": "Resolution",
                    "enum": ["1K", "2K", "4K"],
                    "default": "1K",
                },
                "aspect_ratio": {
                    "type": "string",
                    "title": "Aspect Ratio",
                    "enum": _STANDARD_ASPECT_RATIOS,
                    "default": "1:1",
                },
            },
        },
    },
}


class GeminiProvider(BaseProvider):
    """Google Gemini image generation provider.

    Uses the unified generateContent endpoint which supports:
    - Text-to-image generation
    - Image editing via multimodal prompts (text + reference images)
    - Per-model validated parameters (resolutions, aspect ratios, modalities)
    """

    provider_id = "gemini"
    display_name = "Google Gemini"

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
        """Generate an image from text with optional reference images."""
        return await self._call_gemini(prompt, model_id, params, ref_images, api_key, progress_cb)

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
        """Edit images based on a prompt. Source images are passed as multimodal context."""
        return await self._call_gemini(prompt, model_id, params, source_images, api_key, progress_cb)

    def get_capabilities(self, model_id: str) -> ProviderCapabilities:
        cfg = _MODEL_CONFIGS.get(model_id, {})
        schema = cfg.get("schema", {})
        resolutions = schema.get("properties", {}).get("image_size", {}).get("enum", ["1K"])
        return ProviderCapabilities(
            supports_refs_in_generate=True,
            supports_masks=False,
            max_refs=cfg.get("max_refs", 14),
            max_images_per_call=1,
            supported_resolutions=resolutions,
            has_seed=False,
            has_guidance_scale=False,
            output_formats=["png"],
            capability_type="image_text",
        )

    def get_model_schema(self, model_id: str) -> dict | None:
        cfg = _MODEL_CONFIGS.get(model_id)
        if cfg:
            return cfg["schema"]
        return None

    async def test_key(self, api_key: str) -> tuple[bool, str]:
        """Validate a Gemini API key with a lightweight text-only call."""
        try:
            from google import genai

            client = genai.Client(api_key=api_key)
            # Use a minimal text-only call to validate the key without generating images
            response = await client.aio.models.generate_content(
                model="gemini-2.5-flash",
                contents="Reply with exactly: OK",
            )
            if response and response.text:
                return (True, "API key is valid.")
            return (False, "Key accepted but got unexpected response.")
        except Exception as e:
            error_msg = str(e)
            if "401" in error_msg or "403" in error_msg or "API_KEY_INVALID" in error_msg:
                return (False, "API key is invalid or expired.")
            return (False, f"Could not verify key: {error_msg}")

    def get_supported_models(self) -> list[ModelInfo]:
        return [
            ModelInfo(
                id="gemini-3.1-flash-image-preview",
                name="NanoBanana 2 (Flash)",
                provider_id=self.provider_id,
                description="Next-gen flash model with 512px-4K resolution, extended aspect ratios, and web search grounding.",
            ),
            ModelInfo(
                id="gemini-3-pro-image-preview",
                name="NanoBanana Pro",
                provider_id=self.provider_id,
                description="Professional quality with advanced reasoning. Supports up to 4K and 11 reference images.",
            ),
        ]

    async def _call_gemini(
        self,
        prompt: str,
        model_id: str,
        params: GenerateParams,
        images: list[Image.Image],
        api_key: str,
        progress_cb: Optional[ProgressCallback] = None,
    ) -> list[ImageResult]:
        """Core method that calls the Gemini generateContent API."""
        from google import genai
        from google.genai import types

        if progress_cb:
            progress_cb("Connecting to Gemini...", 0.1)

        client = genai.Client(api_key=api_key)

        # Build contents: text prompt + optional PIL reference images
        contents: list = [prompt]
        if images:
            contents.extend(images)

        # Read model-specific config
        model_cfg = _MODEL_CONFIGS.get(model_id, {})

        # Read params from dynamic_params (set by DynamicSchemaSettings UI)
        # Fall back to legacy GenerateParams fields for backward compatibility
        dynamic: dict = getattr(params, "dynamic_params", None) or {}
        image_size = dynamic.get("image_size") or params.resolution or "1K"
        aspect_ratio = dynamic.get("aspect_ratio") or params.aspect_ratio or "1:1"
        enable_web_search = dynamic.get("enable_web_search", False) or params.enable_web_search

        # Build ImageConfig with this model's validated values
        image_config = types.ImageConfig(
            aspect_ratio=aspect_ratio if aspect_ratio != "auto" else None,
            image_size=image_size,
        )

        # Build GenerateContentConfig with model-specific modalities
        config_kwargs: dict[str, Any] = {"image_config": image_config}
        modalities = model_cfg.get("response_modalities")
        if modalities:
            config_kwargs["response_modalities"] = modalities

        # Web search grounding (3.1 Flash only)
        if enable_web_search:
            config_kwargs["tools"] = [types.Tool(google_search=types.GoogleSearch())]

        config = types.GenerateContentConfig(**config_kwargs)

        if progress_cb:
            progress_cb("Generating with Gemini...", 0.3)

        # Use async client
        response = await client.aio.models.generate_content(
            model=model_id,
            contents=contents,
            config=config,
        )

        if progress_cb:
            progress_cb("Processing response...", 0.8)

        # Extract image from response parts
        results: list[ImageResult] = []
        if response and response.parts:
            for part in response.parts:
                if part.inline_data is not None and part.inline_data.data:
                    pil_image = Image.open(io.BytesIO(part.inline_data.data))
                    results.append(
                        ImageResult(
                            image=pil_image,
                            metadata={
                                "provider": self.provider_id,
                                "model": model_id,
                                "aspect_ratio": aspect_ratio,
                                "resolution": image_size,
                            },
                        )
                    )

        if not results:
            # Check if there was a text response (e.g., safety block)
            text_response = ""
            if response and response.parts:
                for part in response.parts:
                    if part.text:
                        text_response = part.text
                        break
            if text_response:
                raise RuntimeError(f"Gemini returned text instead of an image: {text_response[:200]}")

            # Get debug info safely — SDK bug #2024 can deadlock on finish_reason access
            debug_info = ""
            if response and hasattr(response, "candidates") and response.candidates:
                c = response.candidates[0]
                with concurrent.futures.ThreadPoolExecutor() as executor:
                    try:
                        finish = executor.submit(lambda: getattr(c, "finish_reason", None)).result(timeout=3.0)
                        safety = executor.submit(lambda: getattr(c, "safety_ratings", None)).result(timeout=3.0)
                        debug_info = f" finish_reason={finish}, safety_ratings={safety}"
                    except concurrent.futures.TimeoutError:
                        debug_info = " (SDK timeout reading finish_reason — known bug #2024)"
                if hasattr(response, "prompt_feedback") and response.prompt_feedback:
                    debug_info += f" prompt_feedback={response.prompt_feedback}"
            raise RuntimeError(f"Gemini returned no image in the response.{debug_info}")

        if progress_cb:
            progress_cb("Done", 0.95)

        return results
