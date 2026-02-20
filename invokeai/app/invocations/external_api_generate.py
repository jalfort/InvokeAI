"""External API generation node for InvokeAI.

Provider-agnostic invocation node that delegates to the appropriate external
image generation provider (Gemini, FAL.ai, Replicate, etc.) via the
ProviderRegistry.
"""

import asyncio
import os
from typing import Literal, Optional

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
from invokeai.app.services.external_providers.base import GenerateParams, ImageResult
from invokeai.app.services.external_providers.registry import get_provider_registry
from invokeai.app.services.shared.invocation_context import InvocationContext


@invocation(
    "external_api_generate",
    title="External API Generate",
    tags=["external", "api", "generate", "gemini", "fal", "replicate"],
    category="external_api",
    version="1.0.0",
    classification=Classification.Beta,
    bottleneck=Bottleneck.Network,
)
class ExternalApiGenerateInvocation(BaseInvocation, WithMetadata, WithBoard):
    """Generate or edit images using an external API provider."""

    provider_id: str = InputField(
        default="fal",
        description="External provider to use (e.g. 'fal', 'gemini', 'replicate').",
    )
    model_id: str = InputField(
        default="fal-ai/nano-banana-pro",
        description="Model identifier for the selected provider.",
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
    aspect_ratio: str = InputField(
        default="1:1",
        description="Output image aspect ratio.",
    )
    resolution: str = InputField(
        default="1K",
        description="Output resolution tier.",
    )
    seed: int = InputField(
        default=0,
        description="Seed for reproducibility. 0 for random. Not all providers support this.",
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
    output_format: str = InputField(
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
        description="Guidance scale for models that support it. Leave empty for model default.",
    )
    mask_image: Optional[ImageField] = InputField(
        default=None,
        description="Inpaint mask image (grayscale). When provided and provider lacks native mask support, "
        "rendered as a semi-transparent red overlay on the first reference image with annotation text prepended to prompt.",
    )

    def _get_api_key(self) -> str:
        """Resolve the API key for the selected provider."""
        config = get_config()

        # Check unified api_keys dict
        api_keys: dict[str, str] = config.api_keys
        api_key = api_keys.get(self.provider_id)

        # Legacy fallback for fal provider
        if not api_key and self.provider_id == "fal":
            api_key = config.fal_api_key or os.environ.get("FAL_KEY") or os.environ.get("FAL_API_KEY")

        if not api_key:
            raise ValueError(
                f"API key not configured for provider '{self.provider_id}'. "
                f"Set it via the Settings UI or add it to invokeai.yaml under api_keys."
            )
        return api_key

    def _load_reference_images(self, context: InvocationContext) -> list[Image.Image]:
        """Load reference images as PIL Image objects."""
        pil_images: list[Image.Image] = []
        for img_field in self.reference_images:
            pil_image = context.images.get_pil(img_field.image_name)
            pil_images.append(pil_image)
        return pil_images

    def _apply_mask_annotation(self, base: Image.Image, mask: Image.Image) -> Image.Image:
        """Overlay a semi-transparent red highlight on the masked area of the base image.

        Takes a base image (raster composite) and a grayscale mask (white = masked area)
        and returns a new image with a 50% opacity red overlay where the mask is white.
        """
        base_rgba = base.convert("RGBA")
        mask_l = mask.convert("L").resize(base_rgba.size, Image.LANCZOS)

        # Create a solid red overlay at 50% opacity
        red_overlay = Image.new("RGBA", base_rgba.size, (255, 0, 0, 128))

        # Use the mask as the alpha channel for the overlay (white=visible, black=transparent)
        red_overlay.putalpha(mask_l)

        # Composite the red overlay onto the base
        annotated = Image.alpha_composite(base_rgba, red_overlay)
        return annotated.convert("RGB")

    def _build_params(self) -> GenerateParams:
        """Build the common generation parameters."""
        return GenerateParams(
            aspect_ratio=self.aspect_ratio,
            resolution=self.resolution,
            seed=self.seed,
            num_images=self.num_images,
            output_format=self.output_format,
            safety_tolerance=self.safety_tolerance,
            guidance_scale=self.guidance_scale,
            enable_web_search=self.enable_web_search,
        )

    def invoke(self, context: InvocationContext) -> ImageOutput:
        registry = get_provider_registry()
        provider = registry.get_provider(self.provider_id)
        api_key = self._get_api_key()

        # Load reference images as PIL
        ref_images: list[Image.Image] = []
        if self.reference_images:
            context.util.signal_progress("Loading reference images...", percentage=0.05)
            ref_images = self._load_reference_images(context)

        params = self._build_params()
        prompt = self.prompt

        # Mask-as-annotation: when provider lacks native mask support but a mask is provided,
        # overlay a red highlight on the first reference image and prepend annotation to prompt
        capabilities = provider.get_capabilities(self.model_id)
        if self.mask_image and not capabilities.supports_masks and ref_images:
            context.util.signal_progress("Applying mask annotation...", percentage=0.08)
            mask_pil = context.images.get_pil(self.mask_image.image_name)
            ref_images[0] = self._apply_mask_annotation(ref_images[0], mask_pil)
            prompt = f"Edit the area highlighted in red in the image. {prompt}"

        # Progress callback that signals through InvokeAI context
        def progress_cb(message: str, percentage: float) -> None:
            context.util.signal_progress(message, percentage=percentage)

        is_edit = self.mode == "edit"

        if is_edit and not ref_images:
            raise ValueError("Edit mode requires at least one source image in reference_images.")

        # Run the async provider call from this sync invocation context
        results = asyncio.run(
            self._dispatch(
                provider, is_edit, prompt, self.model_id, ref_images, params,
                api_key, progress_cb, params.num_images, capabilities.max_images_per_call,
            )
        )

        if not results:
            raise RuntimeError(f"Provider '{self.provider_id}' returned no images.")

        # Save all generated images to gallery
        # The first image is returned as the node output; additional images are saved silently
        first_dto = None
        for i, result in enumerate(results):
            image_dto = context.images.save(image=result.image)
            if i == 0:
                first_dto = image_dto

        assert first_dto is not None
        context.util.signal_progress("Complete", percentage=1.0)
        return ImageOutput.build(first_dto)

    async def _dispatch(
        self,
        provider,
        is_edit: bool,
        prompt: str,
        model_id: str,
        images: list[Image.Image],
        params: GenerateParams,
        api_key: str,
        progress_cb,
        total_images: int,
        max_per_call: int,
    ) -> list[ImageResult]:
        """Dispatch to the provider, using a mini-queue for multi-image when needed."""

        async def _call_provider(p: GenerateParams, pcb) -> list[ImageResult]:
            if is_edit:
                return await provider.edit(prompt, model_id, images, p, api_key, pcb)
            else:
                return await provider.generate(prompt, model_id, p, images, api_key, pcb)

        # Single call is enough
        if total_images <= max_per_call:
            return await _call_provider(params, progress_cb)

        # Mini-queue: fire parallel calls when provider returns fewer images per call
        single_params = params.model_copy(update={"num_images": min(max_per_call, 1)})
        num_calls = total_images

        async def single_call(index: int) -> list[ImageResult]:
            def indexed_progress(msg: str, pct: float) -> None:
                overall_pct = (index + pct) / num_calls
                progress_cb(f"Generating image {index + 1}/{num_calls}...", overall_pct * 0.8 + 0.1)

            return await _call_provider(single_params, indexed_progress)

        all_results = await asyncio.gather(*[single_call(i) for i in range(num_calls)])

        # Flatten list of lists
        flat: list[ImageResult] = []
        for batch in all_results:
            flat.extend(batch)
        return flat
