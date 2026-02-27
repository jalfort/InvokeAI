"""FAL.ai dynamic provider for external image generation.

Reads model definitions from dynamic_endpoints.json and dispatches
generation calls to FAL.ai using the fal_client SDK. Supports arbitrary
parameters from dynamically fetched OpenAPI schemas.
"""

import asyncio
import io
import os
from typing import Optional

import requests
from PIL import Image

from invokeai.app.services.external_providers.base import (
    BaseProvider,
    GenerateParams,
    ImageResult,
    ModelInfo,
    ProgressCallback,
    ProviderCapabilities,
)


class FalDynamicProvider(BaseProvider):
    """FAL.ai image generation provider for dynamically added endpoints.

    Unlike the hardcoded Gemini provider, this reads its model list from
    dynamic_endpoints.json (managed by the dynamic_endpoints router).
    """

    provider_id = "fal"
    display_name = "FAL.ai"

    def _load_fal_endpoints(self) -> list[dict]:
        """Load FAL endpoints from dynamic_endpoints.json."""
        from invokeai.app.api.routers.dynamic_endpoints import _load_endpoints

        return [ep for ep in _load_endpoints() if ep.get("provider") == "fal"]

    def get_supported_models(self) -> list[ModelInfo]:
        """Return models from cached dynamic endpoints."""
        endpoints = self._load_fal_endpoints()
        return [
            ModelInfo(
                id=ep["endpoint_id"],
                name=ep["display_name"],
                provider_id=self.provider_id,
                description=ep.get("api_category", ""),
            )
            for ep in endpoints
        ]

    def get_capabilities(self, model_id: str) -> ProviderCapabilities:
        """Return generic capabilities for FAL.ai dynamic endpoints.

        Since each endpoint has different capabilities determined by its schema,
        we return a permissive default. The frontend uses the cached schema
        (not these capabilities) to render dynamic settings.
        """
        return ProviderCapabilities(
            supports_refs_in_generate=True,
            supports_masks=False,
            max_refs=5,
            max_images_per_call=4,
            supported_resolutions=["1K", "2K", "4K"],
            has_seed=True,
            has_guidance_scale=True,
            output_formats=["png", "jpeg", "webp"],
            capability_type="image",
        )

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
        """Generate images via FAL.ai using fal_client.subscribe()."""
        import fal_client

        from invokeai.app.services.external_providers.image_upload import upload_dynamic_images

        # Set the API key for fal_client
        os.environ["FAL_KEY"] = api_key

        # Build arguments starting with the prompt
        arguments: dict = {"prompt": prompt}

        # Add standard params that FAL models commonly accept
        if params.aspect_ratio and params.aspect_ratio != "auto":
            arguments["aspect_ratio"] = params.aspect_ratio
        if params.seed > 0:
            arguments["seed"] = params.seed
        if params.num_images > 0:
            arguments["num_images"] = params.num_images
        if params.output_format:
            arguments["output_format"] = params.output_format

        # Merge dynamic params (schema-driven values from frontend)
        dynamic = getattr(params, "dynamic_params", None)
        if isinstance(dynamic, dict):
            arguments.update(dynamic)

        # Upload reference images to FAL CDN
        if ref_images:
            if progress_cb:
                progress_cb("Uploading reference images...", 0.1)
            uploaded_urls: list[str] = []
            for img in ref_images:
                url = await asyncio.to_thread(fal_client.upload_image, img, format="png")
                uploaded_urls.append(url)
            arguments["image_urls"] = uploaded_urls

        # Upload dynamic image params (schema-driven image fields)
        if dynamic_images:
            if progress_cb:
                progress_cb("Uploading image inputs...", 0.15)
            uploaded = await upload_dynamic_images(dynamic_images, "fal", api_key)
            arguments.update(uploaded)

        if progress_cb:
            progress_cb("Submitting to FAL.ai...", 0.2)

        # Track progress from FAL queue updates
        progress_stage = {"value": 0.3}

        def on_queue_update(update: object) -> None:
            if hasattr(update, "logs") and update.logs:  # type: ignore
                progress_stage["value"] = min(progress_stage["value"] + 0.1, 0.8)
                if progress_cb:
                    progress_cb("Generating...", progress_stage["value"])

        # Call FAL.ai via the queue (blocking, wrapped in asyncio.to_thread)
        result = await asyncio.to_thread(
            fal_client.subscribe,
            model_id,
            arguments=arguments,
            with_logs=True,
            on_queue_update=on_queue_update,
        )

        if progress_cb:
            progress_cb("Downloading results...", 0.9)

        # Download result images
        images_data = result.get("images", [])
        if not images_data:
            # Some FAL models return the image URL at a different key
            image_url = result.get("image", {}).get("url") if isinstance(result.get("image"), dict) else None
            if image_url:
                images_data = [{"url": image_url}]

        if not images_data:
            raise RuntimeError(f"FAL.ai returned no images for endpoint '{model_id}'.")

        results: list[ImageResult] = []
        for img_data in images_data:
            url = img_data.get("url", "")
            if not url:
                continue
            resp = await asyncio.to_thread(requests.get, url, timeout=120)
            resp.raise_for_status()
            pil_image = Image.open(io.BytesIO(resp.content)).convert("RGB")
            results.append(
                ImageResult(
                    image=pil_image,
                    metadata={"provider": self.provider_id, "model": model_id},
                )
            )

        if progress_cb:
            progress_cb("Done", 0.95)

        return results

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
        """Edit uses the same generate path with source images as references."""
        return await self.generate(prompt, model_id, params, source_images, api_key, progress_cb, dynamic_images)

    async def test_key(self, api_key: str) -> tuple[bool, str]:
        """Validate a FAL.ai API key."""
        import httpx

        try:
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.get(
                    "https://rest.alpha.fal.ai/auth/current",
                    headers={"Authorization": f"Key {api_key}"},
                )
            if resp.status_code == 200:
                return (True, "FAL.ai API key is valid.")
            return (False, f"FAL.ai key validation failed (HTTP {resp.status_code}).")
        except Exception as e:
            return (False, f"Could not verify FAL.ai key: {e}")
