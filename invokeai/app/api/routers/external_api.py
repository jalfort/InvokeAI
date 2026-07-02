"""External API provider management endpoints."""

import base64
import io
import logging
from typing import Optional

from fastapi import Body, HTTPException
from fastapi.routing import APIRouter
from PIL import Image
from pydantic import BaseModel, Field

from invokeai.app.api.dependencies import ApiDependencies
from invokeai.app.services.config.config_default import get_config
from invokeai.app.services.external_providers.base import ProviderCapabilities
from invokeai.app.services.external_providers.registry import get_provider_registry
from invokeai.app.services.external_providers.text_completion import (
    TEXT_CAPABLE_PROVIDERS,
    VISION_CAPABLE_PROVIDERS,
    complete_text,
    complete_text_with_image,
)

logger = logging.getLogger("InvokeAI")

external_api_router = APIRouter(prefix="/v1/external_api", tags=["external_api"])

# All known providers — includes those not yet registered in the ProviderRegistry.
# This allows key management for providers before their implementation is available.
KNOWN_PROVIDERS: dict[str, dict[str, str]] = {
    "fal": {"display_name": "FAL.ai", "capability_type": "image"},
    "gemini": {"display_name": "Google Gemini", "capability_type": "image_text"},
    "replicate": {"display_name": "Replicate", "capability_type": "image"},
    "openai": {"display_name": "OpenAI", "capability_type": "text"},
    "openrouter": {"display_name": "OpenRouter", "capability_type": "text"},
    "anthropic": {"display_name": "Anthropic", "capability_type": "text"},
}


class ProviderStatus(BaseModel):
    """Status of an external API provider."""

    provider: str = Field(description="Provider identifier")
    display_name: str = Field(description="Human-readable provider name")
    is_configured: bool = Field(description="Whether an API key is set")
    is_available: bool = Field(default=False, description="Whether the provider implementation is registered")
    capability_type: str = Field(default="image", description="What this provider can do: 'image', 'text', or 'image_text'")


class ProviderListResponse(BaseModel):
    """List of available external API providers."""

    providers: list[ProviderStatus] = Field(description="Available providers")


class ModelWithCapabilities(BaseModel):
    """A model with its provider capabilities."""

    id: str = Field(description="Model identifier")
    name: str = Field(description="Display name")
    provider_id: str = Field(description="Provider serving this model")
    description: str = Field(default="", description="Model description")
    capabilities: Optional[ProviderCapabilities] = Field(default=None, description="Provider capabilities for this model")
    is_dynamic: bool = Field(default=False, description="Whether this is a dynamic endpoint with cached schema")
    cached_schema: Optional[dict] = Field(default=None, description="JSON Schema for dynamic settings UI (only for dynamic endpoints)")


class ModelListResponse(BaseModel):
    """List of all available models across providers."""

    models: list[ModelWithCapabilities] = Field(description="Available models")


class SetKeyRequest(BaseModel):
    """Request to set an API key for a provider."""

    provider: str = Field(description="Provider to set key for")
    api_key: str = Field(description="The API key value")
    persist: bool = Field(default=True, description="Write key to invokeai.yaml for persistence across restarts")


class SetKeyResponse(BaseModel):
    """Response after setting an API key."""

    provider: str = Field(description="Provider that was configured")
    is_configured: bool = Field(description="Whether the key is now set")


class DeleteKeyRequest(BaseModel):
    """Request to delete an API key for a provider."""

    provider: str = Field(description="Provider to remove key for")


class DeleteKeyResponse(BaseModel):
    """Response after deleting an API key."""

    provider: str = Field(description="Provider that was deconfigured")
    is_configured: bool = Field(description="Whether a key is still set (always False)")


class TestKeyRequest(BaseModel):
    """Request to test an API key."""

    provider: str = Field(description="Provider to test")


class TestKeyResponse(BaseModel):
    """Response from testing an API key."""

    provider: str = Field(description="Provider tested")
    is_valid: bool = Field(description="Whether the key is valid")
    message: str = Field(description="Status message")


def _is_provider_configured(provider_id: str) -> bool:
    """Check if an API key is available for a given provider."""
    config = get_config()
    return bool(config.api_keys.get(provider_id))


def _get_provider_key(provider_id: str) -> Optional[str]:
    """Get the API key for a provider."""
    config = get_config()
    return config.api_keys.get(provider_id) or None


@external_api_router.get(
    "/providers",
    operation_id="get_external_api_providers",
    status_code=200,
    response_model=ProviderListResponse,
)
async def get_providers() -> ProviderListResponse:
    """Get the list of all known external API providers and their configuration status.

    Returns both registered providers (with full implementation) and known-but-unregistered
    providers (for key management ahead of implementation).
    """
    registry = get_provider_registry()
    registered_ids: set[str] = set()
    providers: list[ProviderStatus] = []

    # First: add all registered providers (these have full implementations)
    for p in registry.get_all_providers():
        registered_ids.add(p.provider_id)
        models = p.get_supported_models()
        cap_type = "image"
        if models:
            caps = p.get_capabilities(models[0].id)
            cap_type = caps.capability_type

        providers.append(
            ProviderStatus(
                provider=p.provider_id,
                display_name=p.display_name,
                is_configured=_is_provider_configured(p.provider_id),
                is_available=True,
                capability_type=cap_type,
            )
        )

    # Second: add known-but-unregistered providers (for key management)
    for pid, info in KNOWN_PROVIDERS.items():
        if pid not in registered_ids:
            providers.append(
                ProviderStatus(
                    provider=pid,
                    display_name=info["display_name"],
                    is_configured=_is_provider_configured(pid),
                    is_available=False,
                    capability_type=info["capability_type"],
                )
            )

    return ProviderListResponse(providers=providers)


@external_api_router.get(
    "/models",
    operation_id="get_external_api_models",
    status_code=200,
    response_model=ModelListResponse,
)
async def get_models() -> ModelListResponse:
    """Get all available models across all providers with their capabilities."""
    registry = get_provider_registry()
    models: list[ModelWithCapabilities] = []

    # Load dynamic endpoints for schema lookup
    from invokeai.app.api.routers.dynamic_endpoints import _load_endpoints

    dynamic_eps = {ep["endpoint_id"]: ep for ep in _load_endpoints()}

    for provider in registry.get_all_providers():
        for model_info in provider.get_supported_models():
            caps = provider.get_capabilities(model_info.id)
            ep_data = dynamic_eps.get(model_info.id)

            # Schema source: dynamic endpoints use cached_schema from JSON file,
            # hardcoded providers can declare per-model schemas via get_model_schema()
            if ep_data:
                schema = ep_data.get("cached_schema")
                is_dynamic = True
            else:
                schema = provider.get_model_schema(model_info.id)
                is_dynamic = False

            models.append(
                ModelWithCapabilities(
                    id=model_info.id,
                    name=model_info.name,
                    provider_id=model_info.provider_id,
                    description=model_info.description,
                    capabilities=caps,
                    is_dynamic=is_dynamic,
                    cached_schema=schema,
                )
            )

    return ModelListResponse(models=models)


@external_api_router.post(
    "/set_key",
    operation_id="set_external_api_key",
    status_code=200,
    response_model=SetKeyResponse,
)
async def set_key(body: SetKeyRequest = Body(description="API key to set")) -> SetKeyResponse:
    """Set the API key for an external provider.

    Stores in the unified api_keys dict. Optionally persists to invokeai.yaml.
    """
    config = get_config()

    # Store in unified api_keys dict
    config.api_keys[body.provider] = body.api_key

    if body.persist:
        config.write_file(config.config_file_path)

    return SetKeyResponse(provider=body.provider, is_configured=True)


@external_api_router.post(
    "/delete_key",
    operation_id="delete_external_api_key",
    status_code=200,
    response_model=DeleteKeyResponse,
)
async def delete_key(body: DeleteKeyRequest = Body(description="Provider to delete key for")) -> DeleteKeyResponse:
    """Delete the API key for an external provider.

    Removes the key from the unified api_keys dict and persists the change to invokeai.yaml.
    """
    config = get_config()
    config.api_keys.pop(body.provider, None)
    config.write_file(config.config_file_path)
    return DeleteKeyResponse(provider=body.provider, is_configured=False)


@external_api_router.post(
    "/test_key",
    operation_id="test_external_api_key",
    status_code=200,
    response_model=TestKeyResponse,
)
async def test_key(
    body: TestKeyRequest = Body(description="Provider to test"),
) -> TestKeyResponse:
    """Test that a configured API key is valid by delegating to the provider's test_key method."""
    provider_id = body.provider
    registry = get_provider_registry()

    try:
        provider = registry.get_provider(provider_id)
    except KeyError:
        # Provider not registered yet — can't test, but key may still be stored
        api_key = _get_provider_key(provider_id)
        if api_key:
            return TestKeyResponse(
                provider=provider_id,
                is_valid=True,
                message="Key stored. Provider not yet available — cannot verify key validity.",
            )
        return TestKeyResponse(provider=provider_id, is_valid=False, message="No API key configured.")

    api_key = _get_provider_key(provider_id)
    if not api_key:
        return TestKeyResponse(provider=provider_id, is_valid=False, message="No API key configured.")

    try:
        is_valid, message = await provider.test_key(api_key)
        return TestKeyResponse(provider=provider_id, is_valid=is_valid, message=message)
    except Exception as e:
        return TestKeyResponse(provider=provider_id, is_valid=False, message=f"Could not verify key: {e}")


# --- Prompt Optimization ---


class OptimizePromptRequest(BaseModel):
    """Request to optimize a prompt using an LLM."""

    prompt: str = Field(description="The user's current prompt to optimize")
    system_prompt: str = Field(description="System instruction for the optimizer LLM")
    provider: str = Field(description="Which provider to use for text completion")
    model: Optional[str] = Field(default=None, description="Override the default model for this provider")


class OptimizePromptResponse(BaseModel):
    """Response with the optimized prompt."""

    optimized_prompt: str = Field(description="The LLM-optimized prompt text")
    provider: str = Field(description="Provider that was used")
    model: str = Field(description="Model that was used")


class TextCapableProvidersResponse(BaseModel):
    """List of providers that support text completion for prompt optimization."""

    providers: list[str] = Field(description="Provider IDs that support text completion")


@external_api_router.get(
    "/text_providers",
    operation_id="get_text_capable_providers",
    status_code=200,
    response_model=TextCapableProvidersResponse,
)
async def get_text_capable_providers() -> TextCapableProvidersResponse:
    """Get list of providers that support text completion (for prompt optimization).

    Only returns providers that both support text completion AND have a key configured.
    """
    configured = [p for p in TEXT_CAPABLE_PROVIDERS if _is_provider_configured(p)]
    return TextCapableProvidersResponse(providers=sorted(configured))


@external_api_router.post(
    "/optimize_prompt",
    operation_id="optimize_prompt",
    status_code=200,
    response_model=OptimizePromptResponse,
)
async def optimize_prompt(
    body: OptimizePromptRequest = Body(description="Prompt optimization request"),
) -> OptimizePromptResponse:
    """Optimize a prompt using an LLM text completion provider.

    Sends the user's prompt to the selected LLM with the given system prompt,
    and returns the optimized result.
    """
    api_key = _get_provider_key(body.provider)
    if not api_key:
        raise HTTPException(status_code=400, detail=f"No API key configured for provider '{body.provider}'.")

    if body.provider not in TEXT_CAPABLE_PROVIDERS:
        raise HTTPException(
            status_code=400,
            detail=f"Provider '{body.provider}' does not support text completion. Use one of: {sorted(TEXT_CAPABLE_PROVIDERS)}",
        )

    try:
        optimized_text, model_used = await complete_text(
            provider=body.provider,
            api_key=api_key,
            system_prompt=body.system_prompt,
            user_prompt=body.prompt,
            model=body.model,
        )
        return OptimizePromptResponse(
            optimized_prompt=optimized_text,
            provider=body.provider,
            model=model_used,
        )
    except Exception as e:
        logger.error(f"Prompt optimization failed: {e}")
        raise HTTPException(status_code=500, detail=f"Prompt optimization failed: {e}")


# --- Image Description ---


class DescribeImageRequest(BaseModel):
    """Request to describe an image using a vision-capable LLM."""

    image_name: str = Field(description="Name of the image in the gallery")
    system_prompt: str = Field(description="System instruction for the describer LLM")
    provider: str = Field(description="Which provider to use for vision text completion")
    model: Optional[str] = Field(default=None, description="Override the default model for this provider")


class DescribeImageResponse(BaseModel):
    """Response with the image description."""

    description: str = Field(description="The LLM-generated image description")
    provider: str = Field(description="Provider that was used")
    model: str = Field(description="Model that was used")


@external_api_router.post(
    "/describe_image",
    operation_id="describe_image",
    status_code=200,
    response_model=DescribeImageResponse,
)
async def describe_image(
    body: DescribeImageRequest = Body(description="Image description request"),
) -> DescribeImageResponse:
    """Describe an image using a vision-capable LLM.

    Resolves the image by name, downscales if too large, converts to base64 JPEG,
    and sends to the selected LLM with the system prompt.
    """
    api_key = _get_provider_key(body.provider)
    if not api_key:
        raise HTTPException(status_code=400, detail=f"No API key configured for provider '{body.provider}'.")

    if body.provider not in VISION_CAPABLE_PROVIDERS:
        raise HTTPException(
            status_code=400,
            detail=f"Provider '{body.provider}' does not support vision. Use one of: {sorted(VISION_CAPABLE_PROVIDERS)}",
        )

    # Resolve image_name to PIL Image
    try:
        image_files = ApiDependencies.invoker.services.image_files
        pil_image = image_files.get(body.image_name)
    except Exception:
        raise HTTPException(status_code=404, detail=f"Image '{body.image_name}' not found.")

    # Downscale if > 1.5MP (preserve aspect ratio)
    MAX_PIXELS = 1_500_000
    w, h = pil_image.size
    if w * h > MAX_PIXELS:
        scale = (MAX_PIXELS / (w * h)) ** 0.5
        new_w = int(w * scale)
        new_h = int(h * scale)
        pil_image = pil_image.resize((new_w, new_h), Image.LANCZOS)

    # Convert to RGB (handle RGBA/palette images) and encode as JPEG base64
    if pil_image.mode != "RGB":
        pil_image = pil_image.convert("RGB")
    buffer = io.BytesIO()
    pil_image.save(buffer, format="JPEG", quality=85)
    image_base64 = base64.b64encode(buffer.getvalue()).decode("utf-8")

    try:
        description, model_used = await complete_text_with_image(
            provider=body.provider,
            api_key=api_key,
            system_prompt=body.system_prompt,
            user_prompt="Describe this image.",
            image_base64=image_base64,
            model=body.model,
        )
        return DescribeImageResponse(
            description=description,
            provider=body.provider,
            model=model_used,
        )
    except Exception as e:
        logger.error(f"Image description failed: {e}")
        raise HTTPException(status_code=500, detail=f"Image description failed: {e}")
