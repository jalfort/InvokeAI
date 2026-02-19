"""FAL.ai external API generation node for InvokeAI.

Supports txt2img generation and img2img editing via FAL.ai hosted models
(NanoBanana Pro, Flux Kontext, etc.) with optional reference images.
"""

import io
import os
from typing import Literal, Optional

import requests
from PIL import Image

from invokeai.app.invocations.baseinvocation import (
    BaseInvocation,
    Bottleneck,
    Classification,
    invocation,
)
from invokeai.app.invocations.fields import (
    ImageField,
    InputField,
    WithBoard,
    WithMetadata,
)
from invokeai.app.invocations.primitives import ImageOutput
from invokeai.app.services.config.config_default import get_config
from invokeai.app.services.shared.invocation_context import InvocationContext


@invocation(
    "fal_generate",
    title="FAL Generate",
    tags=["fal", "external", "api", "generate", "nanobanana"],
    category="external_api",
    version="1.0.0",
    classification=Classification.Beta,
    bottleneck=Bottleneck.Network,
)
class FalGenerateInvocation(BaseInvocation, WithMetadata, WithBoard):
    """Generate or edit images using FAL.ai external API models."""

    model_id: str = InputField(
        default="fal-ai/nano-banana-pro",
        description="FAL model endpoint ID.",
    )
    prompt: str = InputField(
        description="The text prompt to generate from.",
    )
    mode: Literal["generate", "edit"] = InputField(
        default="generate",
        description="Generate (txt2img) or Edit (img2img with source images).",
    )
    reference_images: list[ImageField] = InputField(
        default_factory=list,
        description="Reference or source images. Optional for generate, required for edit.",
    )
    aspect_ratio: Literal[
        "auto", "21:9", "16:9", "3:2", "4:3", "5:4",
        "1:1", "4:5", "3:4", "2:3", "9:16",
    ] = InputField(
        default="1:1",
        description="Output image aspect ratio.",
    )
    resolution: Literal["1K", "2K", "4K"] = InputField(
        default="1K",
        description="Output resolution tier.",
    )
    seed: int = InputField(
        default=0,
        description="Seed for reproducibility. 0 for random.",
    )
    num_images: int = InputField(
        default=1,
        ge=1,
        le=4,
        description="Number of images to generate (1-4).",
    )
    enable_web_search: bool = InputField(
        default=False,
        description="Allow real-time web information in generation.",
    )
    output_format: Literal["jpeg", "png", "webp"] = InputField(
        default="png",
        description="Output image format.",
    )
    safety_tolerance: int = InputField(
        default=6,
        ge=1,
        le=6,
        description="Safety tolerance (1=most strict, 6=most permissive).",
    )
    guidance_scale: Optional[float] = InputField(
        default=None,
        description="Guidance scale for models that support it (e.g. Kontext). Leave empty to use model default.",
    )

    def _get_api_key(self) -> str:
        """Resolve FAL API key from config or environment."""
        config = get_config()
        api_key = config.fal_api_key or os.environ.get("FAL_KEY") or os.environ.get("FAL_API_KEY")
        if not api_key:
            raise ValueError(
                "FAL API key not configured. Set 'fal_api_key' in invokeai.yaml, "
                "or set the INVOKEAI_FAL_API_KEY or FAL_KEY environment variable."
            )
        return api_key

    def _upload_reference_images(self, context: InvocationContext) -> list[str]:
        """Upload reference images to FAL CDN and return their URLs."""
        import fal_client

        uploaded_urls: list[str] = []
        for i, img_field in enumerate(self.reference_images):
            context.util.signal_progress(
                f"Uploading image {i + 1}/{len(self.reference_images)}...",
                percentage=0.05 + (0.1 * i / max(len(self.reference_images), 1)),
            )
            pil_image = context.images.get_pil(img_field.image_name)
            url = fal_client.upload_image(pil_image, format="png")
            uploaded_urls.append(url)
        return uploaded_urls

    def _build_arguments(self, uploaded_urls: list[str]) -> dict:
        """Build the API request arguments."""
        args: dict = {
            "prompt": self.prompt,
            "aspect_ratio": self.aspect_ratio,
            "resolution": self.resolution,
            "num_images": self.num_images,
            "enable_web_search": self.enable_web_search,
            "output_format": self.output_format,
            "safety_tolerance": self.safety_tolerance,
        }

        if self.seed > 0:
            args["seed"] = self.seed

        if self.guidance_scale is not None:
            args["guidance_scale"] = self.guidance_scale

        if uploaded_urls:
            args["image_urls"] = uploaded_urls

        return args

    def _download_result_image(self, image_url: str) -> Image.Image:
        """Download the result image from FAL CDN."""
        response = requests.get(image_url, timeout=120)
        response.raise_for_status()
        return Image.open(io.BytesIO(response.content)).convert("RGB")

    def invoke(self, context: InvocationContext) -> ImageOutput:
        import fal_client

        # Resolve and set API key
        api_key = self._get_api_key()
        os.environ["FAL_KEY"] = api_key

        # Upload reference images if any
        uploaded_urls: list[str] = []
        if self.reference_images:
            uploaded_urls = self._upload_reference_images(context)

        # Build request
        endpoint = self.model_id
        if self.mode == "edit":
            # NanoBanana edit endpoint is at /edit suffix
            if not endpoint.endswith("/edit"):
                endpoint = f"{endpoint}/edit"
            if not uploaded_urls:
                raise ValueError("Edit mode requires at least one source image in reference_images.")

        args = self._build_arguments(uploaded_urls)

        # Submit to FAL queue and wait for result
        context.util.signal_progress("Submitting to FAL.ai...", percentage=0.2)

        progress_stage = {"value": 0.3}

        def on_queue_update(update: object) -> None:
            if hasattr(update, "logs") and update.logs:  # type: ignore
                progress_stage["value"] = min(progress_stage["value"] + 0.1, 0.8)
                context.util.signal_progress("Generating...", percentage=progress_stage["value"])

        result = fal_client.subscribe(
            endpoint,
            arguments=args,
            with_logs=True,
            on_queue_update=on_queue_update,
        )

        # Download result image
        context.util.signal_progress("Downloading result...", percentage=0.9)

        images = result.get("images", [])
        if not images:
            raise RuntimeError("FAL API returned no images.")

        image_url = images[0]["url"]
        pil_image = self._download_result_image(image_url)

        # Save to InvokeAI image store
        image_dto = context.images.save(image=pil_image)

        context.util.signal_progress("Complete", percentage=1.0)

        return ImageOutput.build(image_dto)
