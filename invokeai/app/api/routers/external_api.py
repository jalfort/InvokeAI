"""External API provider management endpoints."""

from typing import Optional

from fastapi import Body
from fastapi.routing import APIRouter
from pydantic import BaseModel, Field

from invokeai.app.services.config.config_default import get_config
from invokeai.app.services.external_providers.base import ProviderCapabilities
from invokeai.app.services.external_providers.registry import get_provider_registry

external_api_router = APIRouter(prefix="/v1/external_api", tags=["external_api"])

# All known providers — includes those not yet registered in the ProviderRegistry.
# This allows key management for providers before their implementation is available.
KNOWN_PROVIDERS: dict[str, dict[str, str]] = {
    "fal": {"display_name": "FAL.ai", "capability_type": "image"},
    "gemini": {"display_name": "Google Gemini", "capability_type": "image_text"},
    "replicate": {"display_name": "Replicate", "capability_type": "image"},
    "openai": {"display_name": "OpenAI", "capability_type": "image_text"},
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

    for provider in registry.get_all_providers():
        for model_info in provider.get_supported_models():
            caps = provider.get_capabilities(model_info.id)
            models.append(
                ModelWithCapabilities(
                    id=model_info.id,
                    name=model_info.name,
                    provider_id=model_info.provider_id,
                    description=model_info.description,
                    capabilities=caps,
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
