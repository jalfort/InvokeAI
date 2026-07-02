"""OpenAI image generation provider (gpt-image-2 flagship + gpt-image-1.5).

Uses the OpenAI images API for text-to-image (/images/generations) and image
editing (/images/edits). Each model has its own schema-driven settings panel.

Masking is handled "our way" — the invocation paints the masked region solid red
on the source image (see `_apply_mask_annotation`) rather than using OpenAI's
native mask param, so masking behaves identically across every provider. Hence
`supports_masks=False` here.

Key model differences (see docs/dev_api/openai-images-api-2026.md):
- gpt-image-2: flagship. Arbitrary sizes (÷16, aspect 1:3–3:1, ≤3840x2160).
  Always processes inputs at high fidelity → `input_fidelity` must be OMITTED
  (the API rejects it with a 400).
- gpt-image-1.5: prior gen. Supports `input_fidelity` (high|low) on edits.
"""

import asyncio
import base64
import io
import re
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

# Models that accept the `input_fidelity` edit param. gpt-image-2 must OMIT it.
_INPUT_FIDELITY_MODELS = {"gpt-image-1", "gpt-image-1.5", "gpt-image-1-mini"}

# gpt-image-2 arbitrary-size constraints.
_SIZE_DIVISOR = 16
_SIZE_MAX_W = 3840
_SIZE_MAX_H = 2160
_SIZE_MIN_ASPECT = 1 / 3  # width/height
_SIZE_MAX_ASPECT = 3 / 1

_SIZE_SCHEMA_GPT_IMAGE_2 = {
    "type": "string",
    "title": "Size",
    # Presets for the dropdown; the provider also accepts any valid custom WIDTHxHEIGHT
    # (÷16, aspect 1:3–3:1, ≤3840x2160) if the schema is switched to free-text.
    "enum": ["auto", "1024x1024", "1536x1024", "1024x1536", "1536x1536", "2048x2048"],
    "default": "auto",
}
_SIZE_SCHEMA_LEGACY = {
    "type": "string",
    "title": "Size",
    "enum": ["1024x1024", "1024x1536", "1536x1024", "auto"],
    "default": "1024x1024",
}
_QUALITY_SCHEMA = {
    "type": "string",
    "title": "Quality",
    "enum": ["auto", "low", "medium", "high"],
    "default": "auto",
}
_BACKGROUND_SCHEMA = {
    "type": "string",
    "title": "Background",
    "enum": ["auto", "transparent", "opaque"],
    "default": "auto",
}
_MODERATION_SCHEMA = {
    "type": "string",
    "title": "Moderation",
    "enum": ["auto", "low"],
    "default": "auto",
}
_INPUT_FIDELITY_SCHEMA = {
    "type": "string",
    "title": "Input Fidelity",
    "enum": ["high", "low"],
    "default": "high",
}

_MODEL_CONFIGS: dict[str, dict[str, Any]] = {
    "gpt-image-2": {
        "schema": {
            "properties": {
                "size": _SIZE_SCHEMA_GPT_IMAGE_2,
                "quality": _QUALITY_SCHEMA,
                "background": _BACKGROUND_SCHEMA,
                "moderation": _MODERATION_SCHEMA,
                # NOTE: no input_fidelity — gpt-image-2 always processes inputs at high fidelity
                # and rejects the param.
            },
        },
    },
    "gpt-image-1.5": {
        "schema": {
            "properties": {
                "size": _SIZE_SCHEMA_LEGACY,
                "quality": _QUALITY_SCHEMA,
                "background": _BACKGROUND_SCHEMA,
                "moderation": _MODERATION_SCHEMA,
                "input_fidelity": _INPUT_FIDELITY_SCHEMA,
            },
        },
    },
}


def _validate_size(size: str) -> None:
    """Validate a custom WIDTHxHEIGHT size for gpt-image-2. 'auto'/presets pass through.

    Raises ValueError with a clear message on an invalid custom size so the user gets a
    friendly error instead of a raw 400 from the API.
    """
    if size == "auto":
        return
    m = re.fullmatch(r"(\d+)x(\d+)", size.strip())
    if not m:
        return  # not a WxH string (e.g. a preset the API knows) — let the API judge it
    w, h = int(m.group(1)), int(m.group(2))
    if w % _SIZE_DIVISOR != 0 or h % _SIZE_DIVISOR != 0:
        raise ValueError(f"Size {size}: width and height must each be divisible by {_SIZE_DIVISOR}.")
    if w > _SIZE_MAX_W or h > _SIZE_MAX_H:
        raise ValueError(f"Size {size}: max is {_SIZE_MAX_W}x{_SIZE_MAX_H}.")
    aspect = w / h
    if aspect < _SIZE_MIN_ASPECT or aspect > _SIZE_MAX_ASPECT:
        raise ValueError(f"Size {size}: aspect ratio must be between 1:3 and 3:1.")


class OpenAIImageProvider(BaseProvider):
    """OpenAI image generation provider.

    Supports text-to-image via /images/generations and image editing via
    /images/edits. Masking is done via the invocation's red-annotation approach
    (see module docstring), so `supports_masks=False`.
    """

    provider_id = "openai_image"
    display_name = "OpenAI Image"

    def _resolve_common_kwargs(self, model_id: str, dynamic: dict) -> dict[str, Any]:
        """Assemble the size/quality/background kwargs shared by generate + edit.

        NOTE: `moderation` is generations-only in the OpenAI SDK (images.edit rejects it),
        so it is added in generate() rather than here. `input_fidelity` is edit-only and
        added in _edit_images().
        """
        size = dynamic.get("size", "auto")
        _validate_size(size)
        return {
            "size": size,
            "quality": dynamic.get("quality", "auto"),
            "background": dynamic.get("background", "auto"),
        }

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
        common = self._resolve_common_kwargs(model_id, dynamic)

        if progress_cb:
            progress_cb("Generating image...", 0.3)

        if ref_images:
            # Use edit endpoint for image-to-image
            return await self._edit_images(
                client, prompt, model_id, ref_images, dynamic, common, params.num_images, progress_cb
            )

        # Text-to-image generation. `moderation` is generations-only; `input_fidelity` is
        # edit-only, so neither of those is sent from the shared kwargs here.
        response = await client.images.generate(
            model=model_id,
            prompt=prompt,
            n=min(params.num_images, 10),
            moderation=dynamic.get("moderation", "auto"),
            **common,
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
        common = self._resolve_common_kwargs(model_id, dynamic)

        if progress_cb:
            progress_cb("Editing image...", 0.3)

        return await self._edit_images(
            client, prompt, model_id, source_images, dynamic, common, params.num_images, progress_cb
        )

    async def _edit_images(
        self,
        client: Any,
        prompt: str,
        model_id: str,
        images: list[Image.Image],
        dynamic: dict,
        common: dict[str, Any],
        num_images: int,
        progress_cb: Optional[ProgressCallback] = None,
    ) -> list[ImageResult]:
        """Call the OpenAI images/edits endpoint with PIL images.

        `input_fidelity` is sent ONLY for models that support it (gpt-image-1/1.5);
        gpt-image-2 omits it (the API rejects it with a 400).
        """
        # Convert PIL images to PNG bytes for upload. Pass (filename, bytes, mimetype) tuples so the
        # multipart upload carries an image/png content-type — a raw BytesIO uploads as
        # application/octet-stream, which the API rejects with a 400 unsupported_file_mimetype.
        image_files = []
        for idx, img in enumerate(images[:16]):  # Max 16 reference images
            buf = io.BytesIO()
            img.save(buf, format="PNG")
            image_files.append((f"image_{idx}.png", buf.getvalue(), "image/png"))

        edit_kwargs: dict[str, Any] = dict(common)
        if model_id in _INPUT_FIDELITY_MODELS:
            edit_kwargs["input_fidelity"] = dynamic.get("input_fidelity", "high")

        response = await client.images.edit(
            model=model_id,
            image=image_files,
            prompt=prompt,
            n=min(num_images, 10),
            **edit_kwargs,
        )

        if progress_cb:
            progress_cb("Processing response...", 0.8)

        return self._extract_results(response, model_id)

    def _extract_results(self, response: Any, model_id: str) -> list[ImageResult]:
        """Extract PIL images from an OpenAI images response.

        GPT image models always return `b64_json` (never `url`), so that path is primary.
        """
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
                # Fallback: download from URL (dall-e-2/3 only; gpt-image never uses this)
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
            # Masking is handled by the invocation's red-annotation path (our way), like every
            # other provider — not OpenAI's native mask param. Keep this False so the annotation
            # path is used.
            supports_masks=False,
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
                id="gpt-image-2",
                name="GPT Image 2",
                provider_id=self.provider_id,
                description="OpenAI's flagship image model (ChatGPT Images 2.0). Arbitrary sizes, "
                "high-fidelity inputs, up to 16 reference images.",
            ),
            ModelInfo(
                id="gpt-image-1.5",
                name="GPT Image 1.5",
                provider_id=self.provider_id,
                description="Prior-generation OpenAI image model. Supports input fidelity control on edits.",
            ),
        ]
