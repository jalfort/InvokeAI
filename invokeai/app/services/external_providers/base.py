"""Base provider interface and shared types for external image generation providers."""

from abc import ABC, abstractmethod
from typing import Any, Callable, Literal, Optional

from PIL import Image
from pydantic import BaseModel, Field


class ProviderCapabilities(BaseModel):
    """Describes what a provider supports for a given model."""

    supports_refs_in_generate: bool = Field(description="Whether reference images work in generate (txt2img) mode.")
    supports_masks: bool = Field(description="Whether the provider accepts a separate mask image parameter.")
    max_refs: int = Field(description="Maximum number of reference images accepted.")
    max_images_per_call: int = Field(description="How many images the API returns per single call.")
    supported_resolutions: list[str] = Field(description="Resolution tiers the provider supports, e.g. ['1K', '2K'].")
    has_seed: bool = Field(description="Whether the provider supports a seed parameter.")
    has_guidance_scale: bool = Field(description="Whether the provider supports guidance_scale.")
    output_formats: list[str] = Field(description="Supported output formats, e.g. ['png', 'jpeg', 'webp'].")
    capability_type: Literal["image", "text", "image_text"] = Field(
        description="What this provider can do: image generation, text LLM, or both."
    )


class ImageResult(BaseModel):
    """Result from a provider's generate/edit call. Carries a PIL image ready for gallery save."""

    image: Any = Field(description="PIL Image object.")  # Any because PIL.Image.Image isn't a Pydantic type
    metadata: dict[str, Any] = Field(default_factory=dict, description="Provider-specific metadata.")

    model_config = {"arbitrary_types_allowed": True}


class ModelInfo(BaseModel):
    """Describes a model available through a provider."""

    id: str = Field(description="Model identifier used in API calls.")
    name: str = Field(description="Human-readable display name.")
    provider_id: str = Field(description="Which provider serves this model.")
    description: str = Field(default="", description="Short model description.")


# Type alias for progress callbacks: (message: str, percentage: float) -> None
ProgressCallback = Callable[[str, float], None]


class GenerateParams(BaseModel):
    """Common parameters passed to generate/edit calls."""

    aspect_ratio: str = "1:1"
    resolution: str = "1K"
    seed: int = 0
    num_images: int = 1
    output_format: str = "png"
    safety_tolerance: int = 6
    guidance_scale: Optional[float] = None
    enable_web_search: bool = False

    model_config = {"extra": "allow"}  # Providers may add their own params


class BaseProvider(ABC):
    """Abstract base class that all external image generation providers must implement.

    To add a new provider:
      1. Subclass BaseProvider
      2. Implement all abstract methods
      3. Register the instance with the ProviderRegistry
    """

    provider_id: str
    display_name: str

    @abstractmethod
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
        """Generate images from a text prompt with optional reference images.

        Args:
            prompt: Text prompt describing the desired image.
            model_id: The specific model to use (from get_supported_models).
            params: Generation parameters (aspect ratio, resolution, etc.).
            ref_images: Optional PIL reference images for style/content guidance.
            api_key: The API key for this provider.
            progress_cb: Optional callback for progress updates (message, 0.0-1.0).
            dynamic_images: Schema-driven image inputs keyed by field name.
                Each value is a list of PIL images to upload and attach to the API call.

        Returns:
            List of ImageResult with PIL images and metadata.
        """
        ...

    @abstractmethod
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
        """Edit/transform existing images based on a prompt.

        Args:
            prompt: Text prompt describing the desired edit.
            model_id: The specific model to use.
            source_images: Source images to edit (first is primary, rest are references).
            params: Generation parameters.
            api_key: The API key for this provider.
            progress_cb: Optional callback for progress updates.
            dynamic_images: Schema-driven image inputs keyed by field name.

        Returns:
            List of ImageResult with edited PIL images and metadata.
        """
        ...

    @abstractmethod
    def get_capabilities(self, model_id: str) -> ProviderCapabilities:
        """Return the capabilities for a specific model on this provider.

        Different models on the same provider may have different capabilities
        (e.g., Gemini Flash vs Pro have different max resolutions).
        """
        ...

    @abstractmethod
    async def test_key(self, api_key: str) -> tuple[bool, str]:
        """Validate an API key against this provider.

        Returns:
            Tuple of (success: bool, message: str).
            On success: (True, "Key is valid")
            On failure: (False, "Error description")
        """
        ...

    @abstractmethod
    def get_supported_models(self) -> list[ModelInfo]:
        """Return the list of models this provider can serve."""
        ...

    def get_model_schema(self, model_id: str) -> dict | None:
        """Return a JSON Schema describing the model-specific settings UI.

        The schema follows the same format used by DynamicSchemaSettings on the
        frontend.  Each property becomes a UI control (enum → Combobox, boolean →
        Switch, number → Slider, etc.).  Return ``None`` (the default) to fall
        back to the generic settings panel.
        """
        return None
