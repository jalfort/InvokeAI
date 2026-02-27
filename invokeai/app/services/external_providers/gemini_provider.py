"""Google Gemini provider for external image generation.

Uses the google-genai SDK to call Gemini's native generateContent API
with IMAGE response modality. Supports reference images in both
generate and edit modes via multimodal content parts.
"""

import io
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


class GeminiProvider(BaseProvider):
    """Google Gemini image generation provider.

    Uses the unified generateContent endpoint which supports:
    - Text-to-image generation
    - Image editing via multimodal prompts (text + reference images)
    - Up to 14 reference images per call
    - 1 output image per call (use mini-queue for multi-image)
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
        is_pro = "3-pro" in model_id
        return ProviderCapabilities(
            supports_refs_in_generate=True,
            supports_masks=False,
            max_refs=14,
            max_images_per_call=1,
            supported_resolutions=["1K", "2K", "4K"] if is_pro else ["1K", "2K"],
            has_seed=False,
            has_guidance_scale=False,
            output_formats=["png"],
            capability_type="image_text",
        )

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
                id="gemini-2.5-flash-image",
                name="NanoBanana (Flash)",
                provider_id=self.provider_id,
                description="Fast and efficient image generation. Supports 1K-2K resolution.",
            ),
            ModelInfo(
                id="gemini-3-pro-image-preview",
                name="NanoBanana Pro",
                provider_id=self.provider_id,
                description="Professional quality with advanced reasoning. Supports up to 4K and 14 reference images.",
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
        # Gemini accepts PIL images directly in the contents list
        contents: list = [prompt]
        if images:
            contents.extend(images)

        # Build generation config
        image_config = types.ImageConfig(
            aspect_ratio=params.aspect_ratio if params.aspect_ratio != "auto" else None,
        )

        # image_size may not be supported on all models; include it for pro
        caps = self.get_capabilities(model_id)
        if params.resolution in caps.supported_resolutions:
            image_config = types.ImageConfig(
                aspect_ratio=params.aspect_ratio if params.aspect_ratio != "auto" else None,
                image_size=params.resolution,
            )

        config = types.GenerateContentConfig(
            response_modalities=["IMAGE"],
            image_config=image_config,
        )

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
                                "aspect_ratio": params.aspect_ratio,
                                "resolution": params.resolution,
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
            raise RuntimeError("Gemini returned no image in the response.")

        if progress_cb:
            progress_cb("Done", 0.95)

        return results
