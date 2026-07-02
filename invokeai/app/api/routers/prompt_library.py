"""Prompt library endpoints for managing system prompts used in prompt optimization."""

import json
import logging
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from fastapi import Body, HTTPException
from fastapi.routing import APIRouter
from pydantic import BaseModel, Field

from invokeai.app.services.config.config_default import get_config
from invokeai.app.services.external_providers.text_completion import (
    TEXT_CAPABLE_PROVIDERS,
    complete_text,
)

logger = logging.getLogger("InvokeAI")

prompt_library_router = APIRouter(prefix="/v1/prompt_library", tags=["prompt_library"])

# Default system prompt shipped with InvokeAI
DEFAULT_SYSTEM_PROMPT = """You are an expert AI image generation prompt engineer. Your task is to take the user's prompt and enhance it to produce better results with AI image generation models.

Rules:
- Preserve the user's core intent and subject matter
- Add descriptive details about lighting, composition, style, and mood where appropriate
- Use natural, flowing language — not keyword spam
- Keep the output as a single prompt paragraph (no bullet points or labels)
- If the prompt is already detailed, refine rather than overhaul it
- Do NOT add negative prompts or technical parameters
- Output ONLY the optimized prompt text, nothing else"""

# Default description presets for image description feature
DEFAULT_DESCRIBE_DETAILED_PROMPT = """You are an expert image analyst. Describe the given image in rich, structured detail.

Rules:
- Start with the overall scene and subject matter
- Describe composition, framing, and camera angle
- Note lighting conditions, shadows, and color palette
- Identify artistic style, medium, or rendering technique if apparent
- Mention background elements and environmental details
- Describe mood, atmosphere, and emotional tone
- Note any text, symbols, or notable objects
- Be thorough but organized — use flowing prose, not bullet points
- Output ONLY the description, nothing else"""

DEFAULT_DESCRIBE_PROMPT_READY = """You are an AI image generation prompt engineer. Analyze the given image and produce a concise, generation-ready prompt that would recreate it.

Rules:
- Write a single paragraph optimized for AI image generation models
- Include subject, style, lighting, composition, and mood
- Use natural descriptive language, not keyword spam
- Include technical details like camera angle, depth of field, and color grading where apparent
- Keep it under 200 words
- Output ONLY the prompt text, nothing else"""

DEFAULT_DESCRIBE_STYLE_PROMPT = """You are an art critic and style analyst. Analyze the artistic style of the given image.

Rules:
- Identify the artistic style, movement, or genre (e.g., impressionist, photorealistic, anime, concept art)
- Describe the color theory and palette choices
- Analyze the composition techniques used
- Note the rendering technique or medium (digital painting, photography, 3D render, etc.)
- Comment on influences from known artists or art movements if apparent
- Describe the overall aesthetic and visual language
- Keep the analysis focused and insightful
- Output ONLY the style analysis, nothing else"""


class SystemPromptEntry(BaseModel):
    """A saved system prompt for prompt optimization or image description."""

    id: str = Field(description="Unique identifier")
    name: str = Field(description="User-editable display name")
    system_prompt: str = Field(description="The system prompt text")
    category: str = Field(default="optimize", description="Category: 'optimize' for prompt optimization, 'describe' for image description")
    is_default: bool = Field(default=False, description="Whether this is a built-in prompt (cannot be deleted)")
    is_locked: bool = Field(default=False, description="Whether the prompt is locked (read-only, prevents accidental edits)")
    created_at: str = Field(description="ISO timestamp of creation")
    updated_at: str = Field(description="ISO timestamp of last update")


class PromptLibraryListResponse(BaseModel):
    """List of all saved system prompts."""

    prompts: list[SystemPromptEntry] = Field(description="All saved system prompts")


class CreateSystemPromptRequest(BaseModel):
    """Request to create a new system prompt."""

    name: str = Field(description="Display name for the prompt")
    system_prompt: str = Field(description="The system prompt text")
    category: str = Field(default="optimize", description="Category: 'optimize' or 'describe'")


class UpdateSystemPromptRequest(BaseModel):
    """Request to update an existing system prompt."""

    id: str = Field(description="ID of the prompt to update")
    name: Optional[str] = Field(default=None, description="New name (if changing)")
    system_prompt: Optional[str] = Field(default=None, description="New system prompt text (if changing)")
    is_locked: Optional[bool] = Field(default=None, description="Lock/unlock the prompt")


class DeleteSystemPromptRequest(BaseModel):
    """Request to delete a system prompt."""

    id: str = Field(description="ID of the prompt to delete")


class RefineSystemPromptRequest(BaseModel):
    """Request to refine a system prompt using an LLM."""

    system_prompt: str = Field(description="The current system prompt to refine")
    instruction: str = Field(description="How to refine the prompt (e.g., 'focus on cinematic lighting')")
    reference_prompt: Optional[str] = Field(
        default=None, description="Optionally include a reference system prompt as a template example"
    )
    provider: str = Field(description="Which LLM provider to use")
    model: Optional[str] = Field(default=None, description="Override the default model")


class RefineSystemPromptResponse(BaseModel):
    """Response with the refined system prompt."""

    refined_prompt: str = Field(description="The LLM-refined system prompt")
    provider: str = Field(description="Provider used")
    model: str = Field(description="Model used")


def _get_library_path() -> Path:
    """Get the path to the prompt library JSON file."""
    config = get_config()
    return config.root_path / "prompt_library.json"


def _load_library() -> list[dict]:
    """Load the prompt library from disk, creating with defaults if needed."""
    path = _get_library_path()
    if not path.exists():
        defaults = _get_default_entries()
        _save_library(defaults)
        return defaults
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(data, list):
            return _get_default_entries()

        # Migrate: add 'category' to entries that don't have it
        for entry in data:
            if "category" not in entry:
                entry["category"] = "optimize"

        # Ensure all default entries exist (seeds new defaults on upgrade)
        existing_ids = {e["id"] for e in data}
        defaults = _get_default_entries()
        added = False
        for default in defaults:
            if default["id"] not in existing_ids:
                data.append(default)
                added = True
        if added:
            _save_library(data)

        return data
    except (json.JSONDecodeError, OSError):
        return _get_default_entries()


def _save_library(entries: list[dict]) -> None:
    """Save the prompt library to disk."""
    path = _get_library_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(entries, indent=2), encoding="utf-8")


def _get_default_entries() -> list[dict]:
    """Return the built-in default system prompt entries."""
    now = datetime.now(timezone.utc).isoformat()
    return [
        {
            "id": "default-optimizer",
            "name": "Default Optimizer",
            "system_prompt": DEFAULT_SYSTEM_PROMPT,
            "category": "optimize",
            "is_default": True,
            "is_locked": True,
            "created_at": now,
            "updated_at": now,
        },
        {
            "id": "default-describe-detailed",
            "name": "Detailed Description",
            "system_prompt": DEFAULT_DESCRIBE_DETAILED_PROMPT,
            "category": "describe",
            "is_default": True,
            "is_locked": True,
            "created_at": now,
            "updated_at": now,
        },
        {
            "id": "default-describe-prompt-ready",
            "name": "Prompt-Ready",
            "system_prompt": DEFAULT_DESCRIBE_PROMPT_READY,
            "category": "describe",
            "is_default": True,
            "is_locked": True,
            "created_at": now,
            "updated_at": now,
        },
        {
            "id": "default-describe-style",
            "name": "Style Analysis",
            "system_prompt": DEFAULT_DESCRIBE_STYLE_PROMPT,
            "category": "describe",
            "is_default": True,
            "is_locked": True,
            "created_at": now,
            "updated_at": now,
        },
    ]


@prompt_library_router.get(
    "/list",
    operation_id="list_system_prompts",
    status_code=200,
    response_model=PromptLibraryListResponse,
)
async def list_prompts(category: Optional[str] = None) -> PromptLibraryListResponse:
    """List saved system prompts, optionally filtered by category."""
    entries = _load_library()
    if category:
        entries = [e for e in entries if e.get("category", "optimize") == category]
    return PromptLibraryListResponse(prompts=[SystemPromptEntry(**e) for e in entries])


@prompt_library_router.post(
    "/create",
    operation_id="create_system_prompt",
    status_code=201,
    response_model=SystemPromptEntry,
)
async def create_prompt(
    body: CreateSystemPromptRequest = Body(description="System prompt to create"),
) -> SystemPromptEntry:
    """Create a new system prompt in the library."""
    entries = _load_library()
    now = datetime.now(timezone.utc).isoformat()
    new_entry = {
        "id": str(uuid.uuid4()),
        "name": body.name,
        "system_prompt": body.system_prompt,
        "category": body.category,
        "is_default": False,
        "is_locked": False,
        "created_at": now,
        "updated_at": now,
    }
    entries.append(new_entry)
    _save_library(entries)
    return SystemPromptEntry(**new_entry)


@prompt_library_router.put(
    "/update",
    operation_id="update_system_prompt",
    status_code=200,
    response_model=SystemPromptEntry,
)
async def update_prompt(
    body: UpdateSystemPromptRequest = Body(description="System prompt update"),
) -> SystemPromptEntry:
    """Update an existing system prompt (name, content, and/or lock state)."""
    entries = _load_library()
    for entry in entries:
        if entry["id"] == body.id:
            # Allow toggling lock state even on locked prompts
            if body.is_locked is not None:
                entry["is_locked"] = body.is_locked
            # Block content/name edits on locked prompts
            if entry.get("is_locked", False) and (body.name is not None or body.system_prompt is not None):
                raise HTTPException(status_code=400, detail="Cannot edit a locked prompt. Unlock it first.")
            if body.name is not None:
                entry["name"] = body.name
            if body.system_prompt is not None:
                entry["system_prompt"] = body.system_prompt
            entry["updated_at"] = datetime.now(timezone.utc).isoformat()
            _save_library(entries)
            return SystemPromptEntry(**entry)
    raise HTTPException(status_code=404, detail=f"System prompt with id '{body.id}' not found.")


@prompt_library_router.delete(
    "/delete",
    operation_id="delete_system_prompt",
    status_code=200,
)
async def delete_prompt(
    body: DeleteSystemPromptRequest = Body(description="System prompt to delete"),
) -> dict:
    """Delete a system prompt from the library. Default prompts cannot be deleted."""
    entries = _load_library()
    for entry in entries:
        if entry["id"] == body.id:
            if entry.get("is_default", False):
                raise HTTPException(status_code=400, detail="Cannot delete built-in default prompts.")
            entries.remove(entry)
            _save_library(entries)
            return {"deleted": True, "id": body.id}
    raise HTTPException(status_code=404, detail=f"System prompt with id '{body.id}' not found.")


@prompt_library_router.post(
    "/refine",
    operation_id="refine_system_prompt",
    status_code=200,
    response_model=RefineSystemPromptResponse,
)
async def refine_prompt(
    body: RefineSystemPromptRequest = Body(description="System prompt refinement request"),
) -> RefineSystemPromptResponse:
    """Refine a system prompt using an LLM.

    Takes the current system prompt, a refinement instruction, and optionally the user's
    current image prompt as context, then asks the LLM to produce an improved system prompt.
    """
    config = get_config()
    api_key = config.api_keys.get(body.provider)
    if not api_key:
        raise HTTPException(status_code=400, detail=f"No API key configured for provider '{body.provider}'.")

    if body.provider not in TEXT_CAPABLE_PROVIDERS:
        raise HTTPException(
            status_code=400,
            detail=f"Provider '{body.provider}' does not support text completion.",
        )

    # Build the meta-prompt for refinement
    meta_system = (
        "You are a meta-prompt engineer. Your task is to improve a system prompt that is used to optimize "
        "AI image generation prompts. Output ONLY the improved system prompt text, nothing else."
    )
    user_message = f"Current system prompt:\n---\n{body.system_prompt}\n---\n\nRefinement instruction: {body.instruction}"
    if body.reference_prompt:
        user_message += f"\n\nFor reference, here is the default system prompt template to use as a structural guide:\n---\n{body.reference_prompt}\n---"

    try:
        refined_text, model_used = await complete_text(
            provider=body.provider,
            api_key=api_key,
            system_prompt=meta_system,
            user_prompt=user_message,
            model=body.model,
        )
        return RefineSystemPromptResponse(
            refined_prompt=refined_text,
            provider=body.provider,
            model=model_used,
        )
    except Exception as e:
        logger.error(f"System prompt refinement failed: {e}")
        raise HTTPException(status_code=500, detail=f"Refinement failed: {e}")
