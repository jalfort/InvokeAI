"""Replicate dynamic provider for external image generation.

Reads model definitions from dynamic_endpoints.json and dispatches
generation calls to the Replicate API using httpx. Supports arbitrary
parameters from dynamically fetched OpenAPI schemas.
"""

import asyncio
import io
from typing import Optional

import httpx
from PIL import Image

from invokeai.app.services.external_providers.base import (
    BaseProvider,
    GenerateParams,
    ImageResult,
    ModelInfo,
    ProgressCallback,
    ProviderCapabilities,
)

# Replicate prediction polling interval in seconds
_POLL_INTERVAL = 2.0
# Maximum time to wait for a prediction (5 minutes)
_MAX_WAIT = 300.0


class ReplicateDynamicProvider(BaseProvider):
    """Replicate image generation provider for dynamically added endpoints.

    Reads its model list from dynamic_endpoints.json and uses the Replicate
    predictions API for generation with polling for async results.
    """

    provider_id = "replicate"
    display_name = "Replicate"

    def _load_replicate_endpoints(self) -> list[dict]:
        """Load Replicate endpoints from dynamic_endpoints.json."""
        from invokeai.app.api.routers.dynamic_endpoints import _load_endpoints

        return [ep for ep in _load_endpoints() if ep.get("provider") == "replicate"]

    def get_supported_models(self) -> list[ModelInfo]:
        """Return models from cached dynamic endpoints."""
        endpoints = self._load_replicate_endpoints()
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
        """Return generic capabilities for Replicate dynamic endpoints."""
        return ProviderCapabilities(
            supports_refs_in_generate=False,
            supports_masks=False,
            max_refs=1,
            max_images_per_call=4,
            supported_resolutions=["1K", "2K"],
            has_seed=True,
            has_guidance_scale=True,
            output_formats=["png", "webp"],
            capability_type="image",
        )

    def _get_version_for_model(self, model_id: str) -> str:
        """Look up the cached model version hash for a Replicate endpoint."""
        endpoints = self._load_replicate_endpoints()
        for ep in endpoints:
            if ep["endpoint_id"] == model_id:
                return ep.get("model_version", "")
        return ""

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
        """Generate images via Replicate's predictions API."""
        from invokeai.app.services.external_providers.image_upload import upload_dynamic_images

        version = self._get_version_for_model(model_id)

        # Build input
        input_data: dict = {"prompt": prompt}
        if params.seed > 0:
            input_data["seed"] = params.seed

        # Merge dynamic params (schema-driven values from frontend)
        dynamic = getattr(params, "dynamic_params", None)
        if isinstance(dynamic, dict):
            input_data.update(dynamic)

        # Upload dynamic image params (schema-driven image fields)
        if dynamic_images:
            if progress_cb:
                progress_cb("Uploading image inputs...", 0.15)
            uploaded = await upload_dynamic_images(dynamic_images, "replicate", api_key)
            input_data.update(uploaded)

        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }

        # Build prediction request body
        body: dict = {"input": input_data}
        if version:
            body["version"] = version
        else:
            # If no version cached, use the model identifier directly
            body["model"] = model_id

        if progress_cb:
            progress_cb("Submitting to Replicate...", 0.2)

        async with httpx.AsyncClient(timeout=_MAX_WAIT) as client:
            # Create prediction
            resp = await client.post(
                "https://api.replicate.com/v1/predictions",
                json=body,
                headers=headers,
            )
            if resp.status_code == 422:
                detail = resp.json().get("detail", "Invalid input parameters")
                raise RuntimeError(f"Replicate rejected the request: {detail}")
            resp.raise_for_status()
            prediction = resp.json()

            # Poll for completion
            poll_url = prediction.get("urls", {}).get("get", "")
            if not poll_url:
                raise RuntimeError("Replicate did not return a polling URL.")

            elapsed = 0.0
            while prediction.get("status") not in ("succeeded", "failed", "canceled"):
                await asyncio.sleep(_POLL_INTERVAL)
                elapsed += _POLL_INTERVAL
                if elapsed > _MAX_WAIT:
                    raise RuntimeError(f"Replicate prediction timed out after {_MAX_WAIT}s.")

                resp = await client.get(poll_url, headers=headers)
                resp.raise_for_status()
                prediction = resp.json()

                if progress_cb:
                    # Estimate progress based on elapsed time
                    pct = min(0.3 + (elapsed / _MAX_WAIT) * 0.5, 0.8)
                    progress_cb("Generating...", pct)

        status = prediction.get("status", "unknown")
        if status != "succeeded":
            error = prediction.get("error", "Unknown error")
            raise RuntimeError(f"Replicate prediction failed: {error}")

        if progress_cb:
            progress_cb("Downloading results...", 0.9)

        # Download output images
        output = prediction.get("output", [])
        # Some models return a single URL string instead of a list
        if isinstance(output, str):
            output = [output]

        results: list[ImageResult] = []
        async with httpx.AsyncClient(timeout=120) as client:
            for url in output:
                if not isinstance(url, str) or not url.startswith("http"):
                    continue
                resp = await client.get(url)
                resp.raise_for_status()
                pil_image = Image.open(io.BytesIO(resp.content)).convert("RGB")
                results.append(
                    ImageResult(
                        image=pil_image,
                        metadata={"provider": self.provider_id, "model": model_id},
                    )
                )

        if not results:
            raise RuntimeError(f"Replicate returned no downloadable images for '{model_id}'.")

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
        """Edit uses the same generate path (Replicate img2img models accept image in input)."""
        return await self.generate(prompt, model_id, params, source_images, api_key, progress_cb, dynamic_images)

    async def test_key(self, api_key: str) -> tuple[bool, str]:
        """Validate a Replicate API key."""
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.get(
                    "https://api.replicate.com/v1/account",
                    headers={"Authorization": f"Bearer {api_key}"},
                )
            if resp.status_code == 200:
                return (True, "Replicate API key is valid.")
            return (False, f"Replicate key validation failed (HTTP {resp.status_code}).")
        except Exception as e:
            return (False, f"Could not verify Replicate key: {e}")
