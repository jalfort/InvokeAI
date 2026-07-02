"""OpenAI image generation provider (gpt-image-1.5).

Uses the OpenAI images API for text-to-image and image editing.
Each model has its own schema-driven settings panel.
"""

import asyncio
import base64
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

_MODEL_CONFIGS: dict[str, dict[str, Any]] = {
    "gpt-image-1.5": {
        "schema": {
            "properties": {
                "size": {
                    "type": "string",
                    "title": "Size",
                    "enum": ["1024x1024", "1024x1536", "1536x1024", "auto"],
                    "default": "1024x1024",
                },
                "quality": {
                    "type": "string",
                    "title": "Quality",
                    "enum": ["auto", "low", "medium", "high"],
                    "default": "auto",
                },
                "background": {
                    "type": "string",
                    "title": "Background",
                    "enum": ["auto", "transparent", "opaque"],
                    "default": "auto",
                },
            },
        },
    },
}


class OpenAIImageProvider(BaseProvider):
    """OpenAI image generation provider.

    Supports text-to-image via /images/generations and image editing
    via /images/edits (with optional mask for inpainting).
    """

    provider_id = "openai_image"
    display_name = "OpenAI Image"

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
        """Generate images from text, or edit if reference images are provided."""
        from openai import AsyncOpenAI

        if progress_cb:
            progress_cb("Connecting to OpenAI...", 0.1)

        client = AsyncOpenAI(api_key=api_key)

        # Read params from dynamic_params (set by DynamicSchemaSettings UI)
        dynamic: dict = getattr(params, "dynamic_params", None) or {}
        size = dynamic.get("size", "1024x1024")
        quality = dynamic.get("quality", "auto")
        background = dynamic.get("background", "auto")

        if progress_cb:
            progress_cb("Generating image...", 0.3)

        if ref_images:
            # Use edit endpoint for image-to-image
            return await self._edit_images(
                client, prompt, model_id, ref_images, size, quality, background, params.num_images, progress_cb
            )

        # Text-to-image generation
        response = await client.images.generate(
            model=model_id,
            prompt=prompt,
            n=min(params.num_images, 10),
            size=size,
            quality=quality,
            background=background,
        )

        if progress_cb:
            progress_cb("Processing response...", 0.8)

        return self._extract_results(response, model_id)

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
        """Edit images based on a prompt."""
        from openai import AsyncOpenAI

        if progress_cb:
            progress_cb("Connecting to OpenAI...", 0.1)

        client = AsyncOpenAI(api_key=api_key)

        dynamic: dict = getattr(params, "dynamic_params", None) or {}
        size = dynamic.get("size", "1024x1024")
        quality = dynamic.get("quality", "auto")
        background = dynamic.get("background", "auto")

        if progress_cb:
            progress_cb("Editing image...", 0.3)

        return await self._edit_images(
            client, prompt, model_id, source_images, size, quality, background, params.num_images, progress_cb
        )

    async def _edit_images(
        self,
        client: Any,
        prompt: str,
        model_id: str,
        images: list[Image.Image],
        size: str,
        quality: str,
        background: str,
        num_images: int,
        progress_cb: Optional[ProgressCallback] = None,
    ) -> list[ImageResult]:
        """Call the OpenAI images/edits endpoint with PIL images."""
        # Convert PIL images to PNG bytes for upload
        image_files = []
        for img in images[:16]:  # Max 16 reference images
            buf = io.BytesIO()
            img.save(buf, format="PNG")
            buf.seek(0)
            image_files.append(buf)

        response = await client.images.edit(
            model=model_id,
            image=image_files,
            prompt=prompt,
            n=min(num_images, 10),
            size=size,
        )

        if progress_cb:
            progress_cb("Processing response...", 0.8)

        return self._extract_results(response, model_id)

    def _extract_results(self, response: Any, model_id: str) -> list[ImageResult]:
        """Extract PIL images from an OpenAI images response."""
        results: list[ImageResult] = []
        if not response.data:
            raise RuntimeError("OpenAI returned no images in the response.")

        for item in response.data:
            if item.b64_json:
                image_data = base64.b64decode(item.b64_json)
                pil_image = Image.open(io.BytesIO(image_data))
                results.append(
                    ImageResult(
                        image=pil_image,
                        metadata={
                            "provider": self.provider_id,
                            "model": model_id,
                        },
                    )
                )
            elif item.url:
                # Fallback: download from URL
                results.append(self._download_image(item.url, model_id))

        if not results:
            raise RuntimeError("OpenAI response contained no usable image data.")
        return results

    @staticmethod
    def _download_image(url: str, model_id: str) -> ImageResult:
        """Download an image from a URL (synchronous, wrapped by caller)."""
        import requests

        resp = requests.get(url, timeout=30)
        resp.raise_for_status()
        pil_image = Image.open(io.BytesIO(resp.content))
        return ImageResult(
            image=pil_image,
            metadata={"provider": "openai_image", "model": model_id, "source": "url"},
        )

    def get_capabilities(self, model_id: str) -> ProviderCapabilities:
        cfg = _MODEL_CONFIGS.get(model_id, {})
        schema = cfg.get("schema", {})
        sizes = schema.get("properties", {}).get("size", {}).get("enum", ["1024x1024"])
        return ProviderCapabilities(
            supports_refs_in_generate=True,
            supports_masks=True,
            max_refs=16,
            max_images_per_call=10,
            supported_resolutions=sizes,
            has_seed=False,
            has_guidance_scale=False,
            output_formats=["png", "jpeg", "webp"],
            capability_type="image",
        )

    def get_model_schema(self, model_id: str) -> dict | None:
        cfg = _MODEL_CONFIGS.get(model_id)
        if cfg:
            return cfg["schema"]
        return None

    async def test_key(self, api_key: str) -> tuple[bool, str]:
        """Validate an OpenAI API key by listing models."""

        def _test() -> tuple[bool, str]:
            import requests

            try:
                resp = requests.get(
                    "https://api.openai.com/v1/models",
                    headers={"Authorization": f"Bearer {api_key}"},
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
        return [
            ModelInfo(
                id="gpt-image-1.5",
                name="GPT Image 1.5",
                provider_id=self.provider_id,
                description="OpenAI's flagship image generation model. Supports transparent backgrounds and up to 16 reference images.",
            ),
        ]
