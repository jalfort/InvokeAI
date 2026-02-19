"""External API provider management endpoints."""

import os
from typing import Literal

import requests
from fastapi import Body
from fastapi.routing import APIRouter
from pydantic import BaseModel, Field

from invokeai.app.services.config.config_default import get_config

external_api_router = APIRouter(prefix="/v1/external_api", tags=["external_api"])


class ProviderStatus(BaseModel):
    """Status of an external API provider."""

    provider: str = Field(description="Provider identifier")
    display_name: str = Field(description="Human-readable provider name")
    is_configured: bool = Field(description="Whether an API key is set")


class ProviderListResponse(BaseModel):
    """List of available external API providers."""

    providers: list[ProviderStatus] = Field(description="Available providers")


class SetKeyRequest(BaseModel):
    """Request to set an API key for a provider."""

    provider: Literal["fal"] = Field(description="Provider to set key for")
    api_key: str = Field(description="The API key value")
    persist: bool = Field(default=True, description="Write key to invokeai.yaml for persistence across restarts")


class SetKeyResponse(BaseModel):
    """Response after setting an API key."""

    provider: str = Field(description="Provider that was configured")
    is_configured: bool = Field(description="Whether the key is now set")


class TestKeyRequest(BaseModel):
    """Request to test an API key."""

    provider: Literal["fal"] = Field(description="Provider to test")


class TestKeyResponse(BaseModel):
    """Response from testing an API key."""

    provider: str = Field(description="Provider tested")
    is_valid: bool = Field(description="Whether the key is valid")
    message: str = Field(description="Status message")


def _is_fal_configured() -> bool:
    """Check if FAL API key is available from any source."""
    config = get_config()
    return bool(config.fal_api_key or os.environ.get("FAL_KEY") or os.environ.get("FAL_API_KEY"))


@external_api_router.get(
    "/providers",
    operation_id="get_external_api_providers",
    status_code=200,
    response_model=ProviderListResponse,
)
async def get_providers() -> ProviderListResponse:
    """Get the list of available external API providers and their configuration status."""
    providers = [
        ProviderStatus(
            provider="fal",
            display_name="FAL.ai",
            is_configured=_is_fal_configured(),
        ),
    ]
    return ProviderListResponse(providers=providers)


@external_api_router.post(
    "/set_key",
    operation_id="set_external_api_key",
    status_code=200,
    response_model=SetKeyResponse,
)
async def set_key(body: SetKeyRequest = Body(description="API key to set")) -> SetKeyResponse:
    """Set the API key for an external provider.

    Optionally persists to invokeai.yaml so the key survives restarts.
    """
    config = get_config()

    if body.provider == "fal":
        config.fal_api_key = body.api_key
        os.environ["FAL_KEY"] = body.api_key

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
    """Test that a configured API key is valid by making a lightweight API call."""
    provider = body.provider
    if provider == "fal":
        config = get_config()
        api_key = config.fal_api_key or os.environ.get("FAL_KEY") or os.environ.get("FAL_API_KEY")

        if not api_key:
            return TestKeyResponse(provider="fal", is_valid=False, message="No API key configured.")

        try:
            # Validate via a lightweight authenticated REST call (no model execution, no cost)
            resp = requests.get(
                "https://queue.fal.run/fal-ai/fast-sdxl/requests",
                headers={"Authorization": f"Key {api_key}"},
                timeout=10,
            )
            if resp.status_code == 200:
                return TestKeyResponse(provider="fal", is_valid=True, message="API key is valid.")
            if resp.status_code in (401, 403):
                return TestKeyResponse(provider="fal", is_valid=False, message="API key is invalid or expired.")
            return TestKeyResponse(provider="fal", is_valid=False, message=f"Unexpected response ({resp.status_code}).")
        except requests.RequestException as e:
            return TestKeyResponse(provider="fal", is_valid=False, message=f"Could not verify key: {e}")

    return TestKeyResponse(provider=provider, is_valid=False, message=f"Unknown provider: {provider}")
