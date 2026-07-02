"""External image generation provider abstraction layer.

Provides a unified interface for multiple cloud image generation APIs
(Google Gemini, FAL.ai, Replicate, etc.) so that adding a new provider
is just "implement BaseProvider + register in the registry."
"""

from invokeai.app.services.external_providers.base import (
    BaseProvider,
    ImageResult,
    ModelInfo,
    ProviderCapabilities,
)
from invokeai.app.services.external_providers.registry import ProviderRegistry

__all__ = [
    "BaseProvider",
    "ImageResult",
    "ModelInfo",
    "ProviderCapabilities",
    "ProviderRegistry",
]
