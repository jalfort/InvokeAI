"""Dynamic endpoint management for FAL.ai and Replicate models.

Users paste a model slug (e.g., 'fal-ai/flux-2-pro') or full URL, and this
module fetches the OpenAPI schema, resolves a display name, and caches everything
in dynamic_endpoints.json for the frontend to render dynamic settings UIs.
"""

import json
import logging
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal, Optional

import httpx
from fastapi import Body, HTTPException
from fastapi.routing import APIRouter
from pydantic import BaseModel, Field

from invokeai.app.services.config.config_default import get_config

logger = logging.getLogger("InvokeAI")

dynamic_endpoints_router = APIRouter(prefix="/v1/dynamic_endpoints", tags=["dynamic_endpoints"])


# ---------------------------------------------------------------------------
# Data model
# ---------------------------------------------------------------------------


class DynamicEndpoint(BaseModel):
    """A cached dynamic API endpoint with its input schema."""

    id: str = Field(description="Unique identifier (UUID4)")
    provider: Literal["fal", "replicate"] = Field(description="Which API platform this endpoint belongs to")
    endpoint_id: str = Field(description="Model endpoint identifier, e.g. 'fal-ai/flux-2-pro'")
    display_name: str = Field(description="Human-readable name (auto-fetched, user-renameable)")
    api_category: str = Field(default="", description="Category from the API metadata, e.g. 'text-to-image'")
    user_category: str = Field(default="", description="User-editable category for custom grouping")
    cached_schema: dict = Field(default_factory=dict, description="The input JSON Schema for dynamic settings UI")
    cached_at: str = Field(description="ISO timestamp of last schema fetch")
    model_version: str = Field(default="", description="Replicate model version hash (empty for FAL)")


class DynamicEndpointListResponse(BaseModel):
    """List of all cached dynamic endpoints."""

    endpoints: list[DynamicEndpoint] = Field(description="All cached endpoints")


class AddEndpointRequest(BaseModel):
    """Request to add a new dynamic endpoint."""

    endpoint_input: str = Field(
        description="Model slug or full URL, e.g. 'fal-ai/flux-2-pro' or 'https://fal.ai/models/fal-ai/flux-2-pro'"
    )
    provider_hint: Optional[Literal["fal", "replicate"]] = Field(
        default=None, description="Optional provider override for ambiguous slugs"
    )


class RenameEndpointRequest(BaseModel):
    """Request to rename a dynamic endpoint."""

    id: str = Field(description="Endpoint UUID to rename")
    display_name: str = Field(description="New display name")


class SetCategoryRequest(BaseModel):
    """Request to change a dynamic endpoint's user category."""

    id: str = Field(description="Endpoint UUID")
    user_category: str = Field(description="New user category (empty string to clear)")


class UpdateEndpointRequest(BaseModel):
    """Request to update one or more fields of a dynamic endpoint."""

    id: str = Field(description="Endpoint UUID to update")
    display_name: Optional[str] = Field(default=None, description="New display name (None = keep current)")
    api_category: Optional[str] = Field(default=None, description="New API category (None = keep current)")
    user_category: Optional[str] = Field(default=None, description="New user category (None = keep current)")


class RefreshEndpointRequest(BaseModel):
    """Request to re-fetch the schema for a dynamic endpoint."""

    id: str = Field(description="Endpoint UUID to refresh")


class DeleteEndpointRequest(BaseModel):
    """Request to delete a dynamic endpoint."""

    id: str = Field(description="Endpoint UUID to delete")


# ---------------------------------------------------------------------------
# Storage helpers — same pattern as prompt_library.py
# ---------------------------------------------------------------------------


def _get_endpoints_path() -> Path:
    """Get the path to dynamic_endpoints.json in the InvokeAI root directory."""
    config = get_config()
    return config.root_path / "dynamic_endpoints.json"


def _load_endpoints() -> list[dict]:
    """Load all dynamic endpoints from the JSON file."""
    path = _get_endpoints_path()
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, list) else []
    except (json.JSONDecodeError, OSError) as e:
        logger.warning(f"Failed to load dynamic_endpoints.json: {e}")
        return []


def _save_endpoints(entries: list[dict]) -> None:
    """Save all dynamic endpoints to the JSON file."""
    path = _get_endpoints_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(entries, indent=2, ensure_ascii=False), encoding="utf-8")


def _find_endpoint(entries: list[dict], endpoint_id: str) -> Optional[dict]:
    """Find an endpoint by its UUID."""
    for ep in entries:
        if ep.get("id") == endpoint_id:
            return ep
    return None


async def refresh_replicate_version(model_slug: str, api_key: str) -> str:
    """Fetch the latest version hash for a Replicate model and update the cache.

    Returns the new version hash, or empty string if the fetch fails.
    """
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.get(
                f"https://api.replicate.com/v1/models/{model_slug}",
                headers={"Authorization": f"Bearer {api_key}"},
            )
            if resp.status_code != 200:
                logger.warning(f"Failed to refresh Replicate version for {model_slug}: HTTP {resp.status_code}")
                return ""
            data = resp.json()
            new_version = data.get("latest_version", {}).get("id", "")
            if not new_version:
                return ""

        # Update the cached endpoint
        entries = _load_endpoints()
        for ep in entries:
            if ep.get("endpoint_id") == model_slug and ep.get("provider") == "replicate":
                ep["model_version"] = new_version
                logger.info(f"Refreshed Replicate version for {model_slug}: {new_version[:12]}...")
                break
        _save_endpoints(entries)
        return new_version
    except Exception as e:
        logger.warning(f"Error refreshing Replicate version for {model_slug}: {e}")
        return ""


# ---------------------------------------------------------------------------
# Slug / URL parsing
# ---------------------------------------------------------------------------


def _parse_endpoint_input(
    raw_input: str,
    provider_hint: Optional[Literal["fal", "replicate"]] = None,
) -> tuple[Literal["fal", "replicate"], str]:
    """Parse a slug or URL into (provider, endpoint_id).

    Detection priority:
      1. URL domain (fal.ai / fal.run / replicate.com) — definitive
      2. fal-ai/ prefix — definitive FAL first-party
      3. Replicate version hash (owner/model:hex64) — definitive Replicate
      4. User-provided provider_hint
      5. Path depth heuristic: 3+ segments → FAL (third-party vendors)
      6. Default: Replicate (2-segment owner/model)

    Examples:
        "fal-ai/flux-2-pro"                                -> ("fal", "fal-ai/flux-2-pro")
        "https://fal.ai/models/fal-ai/flux-2-pro"          -> ("fal", "fal-ai/flux-2-pro")
        "https://fal.ai/models/clarityai/crystal-upscaler"  -> ("fal", "clarityai/crystal-upscaler")
        "recraft/v4/pro/text-to-image"                      -> ("fal", "recraft/v4/pro/text-to-image")
        "https://replicate.com/stability-ai/sdxl"           -> ("replicate", "stability-ai/sdxl")
        "bytedance/seedream-4"                              -> ("replicate", "bytedance/seedream-4")
    """
    cleaned = raw_input.strip().rstrip("/")

    # ── Step 1: URL-based detection (definitive) ──────────────────

    # FAL URLs: fal.ai/models/..., fal.run/...
    if "fal.ai" in cleaned or "fal.run" in cleaned:
        slug = _extract_fal_slug(cleaned)
        return ("fal", slug)

    # Replicate URLs: replicate.com/..., api.replicate.com/...
    if "replicate.com" in cleaned:
        slug = _extract_replicate_slug(cleaned)
        return ("replicate", slug)

    # ── Step 2: Definitive prefix/suffix markers ──────────────────

    # fal-ai/ prefix → always FAL first-party
    if cleaned.startswith("fal-ai/"):
        return ("fal", cleaned)

    # Replicate version hash: owner/model:64_hex_chars
    if re.match(r"^[^/]+/[^/:]+:[0-9a-f]{64}$", cleaned):
        slug = cleaned.split(":")[0]
        return ("replicate", slug)

    # ── Step 3: User-provided hint ────────────────────────────────
    if provider_hint:
        return (provider_hint, cleaned)

    # ── Step 4: Path depth heuristic ──────────────────────────────
    # FAL third-party slugs often have 3+ segments (recraft/v4/text-to-image)
    # Replicate slugs are always exactly 2 segments (owner/model)
    segments = cleaned.split("/")
    if len(segments) >= 3:
        return ("fal", cleaned)

    # ── Step 5: Ambiguous 2-segment slug → default Replicate ─────
    return ("replicate", cleaned)


def _extract_fal_slug(url: str) -> str:
    """Extract model slug from a FAL URL, stripping page suffixes."""
    cleaned = url.rstrip("/")

    # fal.run/slug format
    if "fal.run/" in cleaned:
        match = re.search(r"fal\.run/(.+)", cleaned)
        slug = match.group(1) if match else cleaned
    # fal.ai/models/slug format
    elif "fal.ai/models/" in cleaned:
        match = re.search(r"fal\.ai/models/(.+)", cleaned)
        slug = match.group(1) if match else cleaned
    else:
        slug = cleaned

    # Strip known URL-only suffixes that aren't part of the model slug
    slug = re.sub(r"/(api|playground|examples)$", "", slug)
    return slug.rstrip("/")


def _extract_replicate_slug(url: str) -> str:
    """Extract owner/model from a Replicate URL, stripping version paths."""
    cleaned = url.rstrip("/")

    # API URL: api.replicate.com/v1/models/owner/model
    api_match = re.search(r"api\.replicate\.com/v1/models/([^/]+/[^/]+)", cleaned)
    if api_match:
        return api_match.group(1)

    # Web URL: replicate.com/owner/model[/versions/...]
    web_match = re.search(r"replicate\.com/([^/]+/[^/?#]+)", cleaned)
    if web_match:
        return web_match.group(1)

    return cleaned


# ---------------------------------------------------------------------------
# Schema fetching
# ---------------------------------------------------------------------------


def _resolve_refs(node: dict, definitions: dict, _seen: set[str] | None = None) -> dict:
    """Recursively resolve all $ref pointers in a JSON Schema using the provided definitions.

    Walks the schema tree and replaces each {"$ref": "#/components/schemas/Foo"} with the
    actual content of definitions["Foo"]. Tracks visited refs to prevent infinite recursion.

    Args:
        node: The schema node to resolve.
        definitions: The full `components.schemas` dict from the OpenAPI document.
        _seen: Internal set of visited $ref paths (for cycle detection).
    """
    if _seen is None:
        _seen = set()

    if not isinstance(node, dict):
        return node

    # Direct $ref — resolve it
    if "$ref" in node and len(node) == 1:
        ref_path = node["$ref"]
        if ref_path in _seen:
            return node  # Cycle detected, return as-is
        # Extract the definition name: "#/components/schemas/ImageSize" → "ImageSize"
        ref_name = ref_path.rsplit("/", 1)[-1]
        resolved = definitions.get(ref_name)
        if resolved and isinstance(resolved, dict):
            # Copy _seen so sibling properties can resolve the same $ref independently
            branch_seen = _seen | {ref_path}
            return _resolve_refs(dict(resolved), definitions, branch_seen)
        return node

    # $ref alongside other keys (e.g., {"$ref": "...", "default": "1:1"})
    # Merge the resolved ref with the extra keys
    if "$ref" in node:
        ref_path = node["$ref"]
        if ref_path not in _seen:
            ref_name = ref_path.rsplit("/", 1)[-1]
            resolved = definitions.get(ref_name)
            if resolved and isinstance(resolved, dict):
                branch_seen = _seen | {ref_path}
                merged = dict(resolved)
                for k, v in node.items():
                    if k != "$ref":
                        merged[k] = v
                return _resolve_refs(merged, definitions, branch_seen)

    # Recurse into all dict/list children
    result = {}
    for key, value in node.items():
        if isinstance(value, dict):
            result[key] = _resolve_refs(value, definitions, _seen)
        elif isinstance(value, list):
            result[key] = [
                _resolve_refs(item, definitions, _seen) if isinstance(item, dict) else item for item in value
            ]
        else:
            result[key] = value
    return result


async def _fetch_fal_schema(endpoint_id: str) -> tuple[str, str, dict]:
    """Fetch display name, category, and input schema from FAL.ai.

    FAL's schema endpoint requires NO authentication.

    Returns:
        (display_name, api_category, input_schema_dict)
    """
    # 1. Fetch OpenAPI schema (no auth)
    schema_url = f"https://fal.ai/api/openapi/queue/openapi.json?endpoint_id={endpoint_id}"
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.get(schema_url)
        if resp.status_code != 200:
            raise HTTPException(
                status_code=400,
                detail=f"Failed to fetch schema from FAL.ai for '{endpoint_id}' (HTTP {resp.status_code}). Check the endpoint slug.",
            )
        openapi = resp.json()

    # 2. Extract input schema from components.schemas
    schemas = openapi.get("components", {}).get("schemas", {})
    input_schema: dict = {}
    # Look for schemas ending with "Input" (e.g., "FluxProV11Input")
    for name, schema in schemas.items():
        if name == "Input" or name.endswith("Input"):
            # Prefer schemas that have properties (skip simple refs)
            if "properties" in schema:
                input_schema = schema
                break
    # Fallback: grab the first schema with properties
    if not input_schema:
        for _name, schema in schemas.items():
            if isinstance(schema, dict) and "properties" in schema:
                input_schema = schema
                break

    # 2b. Inline-resolve all $ref pointers so the cached schema is self-contained
    if input_schema:
        input_schema = _resolve_refs(input_schema, schemas)

    # 3. Resolve display name from the models list API (no auth)
    # Fallback: parse from slug
    slug_parts = endpoint_id.replace("fal-ai/", "").split("/")
    display_name = " ".join(slug_parts).replace("-", " ").title()
    api_category = ""

    # Extract category from schema metadata if available
    info = openapi.get("info", {})
    metadata = info.get("x-fal-metadata", {})
    if metadata.get("category"):
        api_category = metadata["category"]

    try:
        async with httpx.AsyncClient(timeout=15) as client:
            models_resp = await client.get("https://fal.ai/api/models", params={"limit": 200})
            if models_resp.status_code == 200:
                models_data = models_resp.json()
                # Models list can be a list or dict with items
                models_list = models_data if isinstance(models_data, list) else models_data.get("items", [])
                for model in models_list:
                    model_id = model.get("id", "") or model.get("endpoint_id", "") or model.get("slug", "")
                    if model_id == endpoint_id or endpoint_id in model_id:
                        display_name = model.get("title", display_name)
                        api_category = api_category or model.get("category", "")
                        break
    except Exception as e:
        logger.debug(f"Could not fetch FAL models list for display name: {e}")

    return (display_name, api_category, input_schema)


async def _fetch_replicate_schema(endpoint_id: str, api_key: str) -> tuple[str, str, dict, str]:
    """Fetch display name, category, input schema, and version from Replicate.

    Replicate's API REQUIRES authentication.

    Returns:
        (display_name, api_category, input_schema_dict, model_version)
    """
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.get(
            f"https://api.replicate.com/v1/models/{endpoint_id}",
            headers={"Authorization": f"Bearer {api_key}"},
        )
        if resp.status_code == 401:
            raise HTTPException(status_code=400, detail="Replicate API key is invalid or expired.")
        if resp.status_code == 404:
            raise HTTPException(status_code=400, detail=f"Replicate model '{endpoint_id}' not found.")
        if resp.status_code != 200:
            raise HTTPException(
                status_code=400,
                detail=f"Failed to fetch model from Replicate for '{endpoint_id}' (HTTP {resp.status_code}).",
            )
        data = resp.json()

    # Parse display name from slug (Replicate has no title field)
    name_slug = data.get("name", endpoint_id.split("/")[-1])
    display_name = name_slug.replace("-", " ").replace("_", " ").title()

    # Use description prefix as category proxy
    description = data.get("description", "")
    api_category = ""
    # Try to infer category from description keywords
    desc_lower = description.lower()
    if "text-to-image" in desc_lower or "text to image" in desc_lower:
        api_category = "text-to-image"
    elif "image-to-image" in desc_lower or "image to image" in desc_lower:
        api_category = "image-to-image"
    elif "upscal" in desc_lower:
        api_category = "upscaler"
    elif "video" in desc_lower:
        api_category = "video"

    # Extract schema and version
    latest = data.get("latest_version", {})
    model_version = latest.get("id", "")
    openapi_schema = latest.get("openapi_schema", {})
    all_schemas = openapi_schema.get("components", {}).get("schemas", {})
    input_schema = all_schemas.get("Input", {})

    # Inline-resolve all $ref pointers so the cached schema is self-contained
    if input_schema:
        input_schema = _resolve_refs(input_schema, all_schemas)

    return (display_name, api_category, input_schema, model_version)


def _get_provider_key(provider_id: str) -> Optional[str]:
    """Get the API key for a provider from config."""
    config = get_config()
    return config.api_keys.get(provider_id) or None


# ---------------------------------------------------------------------------
# Router endpoints
# ---------------------------------------------------------------------------


@dynamic_endpoints_router.get(
    "/list",
    operation_id="list_dynamic_endpoints",
    status_code=200,
    response_model=DynamicEndpointListResponse,
)
async def list_endpoints() -> DynamicEndpointListResponse:
    """List all cached dynamic endpoints."""
    entries = _load_endpoints()
    endpoints = [DynamicEndpoint(**ep) for ep in entries]
    return DynamicEndpointListResponse(endpoints=endpoints)


@dynamic_endpoints_router.post(
    "/add",
    operation_id="add_dynamic_endpoint",
    status_code=201,
    response_model=DynamicEndpoint,
)
async def add_endpoint(body: AddEndpointRequest = Body(description="Endpoint slug or URL to add")) -> DynamicEndpoint:
    """Add a new dynamic endpoint by fetching its schema.

    Accepts a model slug (e.g., 'fal-ai/flux-2-pro') or full URL.
    Auto-detects the provider (FAL.ai or Replicate) from the input.
    """
    provider, endpoint_id = _parse_endpoint_input(body.endpoint_input, body.provider_hint)

    # Check for duplicates
    entries = _load_endpoints()
    for ep in entries:
        if ep.get("endpoint_id") == endpoint_id and ep.get("provider") == provider:
            raise HTTPException(status_code=409, detail=f"Endpoint '{endpoint_id}' is already added.")

    # Fetch schema based on provider
    if provider == "fal":
        display_name, api_category, schema = await _fetch_fal_schema(endpoint_id)
        model_version = ""
    else:
        api_key = _get_provider_key("replicate")
        if not api_key:
            raise HTTPException(
                status_code=400,
                detail="Replicate API key required. Configure it in Settings first.",
            )
        display_name, api_category, schema, model_version = await _fetch_replicate_schema(endpoint_id, api_key)

    entry = DynamicEndpoint(
        id=str(uuid.uuid4()),
        provider=provider,
        endpoint_id=endpoint_id,
        display_name=display_name,
        api_category=api_category,
        cached_schema=schema,
        cached_at=datetime.now(timezone.utc).isoformat(),
        model_version=model_version,
    )

    entries.append(entry.model_dump())
    _save_endpoints(entries)

    logger.info(f"Added dynamic endpoint: {provider}/{endpoint_id} ({display_name})")
    return entry


@dynamic_endpoints_router.post(
    "/rename",
    operation_id="rename_dynamic_endpoint",
    status_code=200,
    response_model=DynamicEndpoint,
)
async def rename_endpoint(body: RenameEndpointRequest = Body(description="Rename request")) -> DynamicEndpoint:
    """Rename a dynamic endpoint's display name."""
    entries = _load_endpoints()
    ep = _find_endpoint(entries, body.id)
    if not ep:
        raise HTTPException(status_code=404, detail=f"Endpoint '{body.id}' not found.")

    ep["display_name"] = body.display_name.strip()
    _save_endpoints(entries)

    return DynamicEndpoint(**ep)


@dynamic_endpoints_router.post(
    "/set_category",
    operation_id="set_endpoint_category",
    status_code=200,
    response_model=DynamicEndpoint,
)
async def set_category(body: SetCategoryRequest = Body(description="Category change request")) -> DynamicEndpoint:
    """Change a dynamic endpoint's user category."""
    entries = _load_endpoints()
    ep = _find_endpoint(entries, body.id)
    if not ep:
        raise HTTPException(status_code=404, detail=f"Endpoint '{body.id}' not found.")

    ep["user_category"] = body.user_category.strip()
    _save_endpoints(entries)

    return DynamicEndpoint(**ep)


@dynamic_endpoints_router.post(
    "/update",
    operation_id="update_dynamic_endpoint",
    status_code=200,
    response_model=DynamicEndpoint,
)
async def update_endpoint(body: UpdateEndpointRequest = Body(description="Update request")) -> DynamicEndpoint:
    """Update one or more fields of a dynamic endpoint in a single call."""
    entries = _load_endpoints()
    ep = _find_endpoint(entries, body.id)
    if not ep:
        raise HTTPException(status_code=404, detail=f"Endpoint '{body.id}' not found.")

    if body.display_name is not None:
        ep["display_name"] = body.display_name.strip()
    if body.api_category is not None:
        ep["api_category"] = body.api_category.strip()
    if body.user_category is not None:
        ep["user_category"] = body.user_category.strip()

    _save_endpoints(entries)

    return DynamicEndpoint(**ep)


@dynamic_endpoints_router.post(
    "/refresh",
    operation_id="refresh_dynamic_endpoint",
    status_code=200,
    response_model=DynamicEndpoint,
)
async def refresh_endpoint(body: RefreshEndpointRequest = Body(description="Refresh request")) -> DynamicEndpoint:
    """Re-fetch the schema for a dynamic endpoint from the API."""
    entries = _load_endpoints()
    ep = _find_endpoint(entries, body.id)
    if not ep:
        raise HTTPException(status_code=404, detail=f"Endpoint '{body.id}' not found.")

    provider = ep["provider"]
    endpoint_id = ep["endpoint_id"]

    if provider == "fal":
        display_name, api_category, schema = await _fetch_fal_schema(endpoint_id)
        ep["cached_schema"] = schema
        # Only overwrite api_category if the API returned one; preserve user's manual override otherwise
        if api_category:
            ep["api_category"] = api_category
    else:
        api_key = _get_provider_key("replicate")
        if not api_key:
            raise HTTPException(status_code=400, detail="Replicate API key required for schema refresh.")
        display_name, api_category, schema, model_version = await _fetch_replicate_schema(endpoint_id, api_key)
        ep["cached_schema"] = schema
        if api_category:
            ep["api_category"] = api_category
        ep["model_version"] = model_version

    ep["cached_at"] = datetime.now(timezone.utc).isoformat()
    _save_endpoints(entries)

    logger.info(f"Refreshed schema for dynamic endpoint: {provider}/{endpoint_id}")
    return DynamicEndpoint(**ep)


@dynamic_endpoints_router.post(
    "/delete",
    operation_id="delete_dynamic_endpoint",
    status_code=200,
)
async def delete_endpoint(body: DeleteEndpointRequest = Body(description="Delete request")) -> dict:
    """Delete a dynamic endpoint."""
    entries = _load_endpoints()
    original_len = len(entries)
    entries = [ep for ep in entries if ep.get("id") != body.id]

    if len(entries) == original_len:
        raise HTTPException(status_code=404, detail=f"Endpoint '{body.id}' not found.")

    _save_endpoints(entries)
    logger.info(f"Deleted dynamic endpoint: {body.id}")
    return {"deleted": True}
