from enum import Enum
from importlib.metadata import distributions
from threading import Lock
from typing import Any

import torch
from fastapi import Body
from fastapi.routing import APIRouter
from pydantic import BaseModel, Field, model_validator

from invokeai.app.api.auth_dependencies import AdminUserOrDefault
from invokeai.app.api.dependencies import ApiDependencies
from invokeai.app.services.config.config_default import (
    IMAGE_SUBFOLDER_STRATEGY,
    DefaultInvokeAIAppConfig,
    InvokeAIAppConfig,
    get_config,
    load_and_migrate_config,
)
from invokeai.app.services.invocation_cache.invocation_cache_common import InvocationCacheStatus
from invokeai.backend.image_util.infill_methods.patchmatch import PatchMatch
from invokeai.backend.util.logging import logging
from invokeai.version import __version__


class LogLevel(int, Enum):
    NotSet = logging.NOTSET
    Debug = logging.DEBUG
    Info = logging.INFO
    Warning = logging.WARNING
    Error = logging.ERROR
    Critical = logging.CRITICAL


app_router = APIRouter(prefix="/v1/app", tags=["app"])


class AppVersion(BaseModel):
    """App Version Response"""

    version: str = Field(description="App version")


@app_router.get("/version", operation_id="app_version", status_code=200, response_model=AppVersion)
async def get_version() -> AppVersion:
    return AppVersion(version=__version__)


@app_router.get("/app_deps", operation_id="get_app_deps", status_code=200, response_model=dict[str, str])
async def get_app_deps() -> dict[str, str]:
    deps: dict[str, str] = {dist.metadata["Name"]: dist.version for dist in distributions()}
    try:
        cuda = getattr(getattr(torch, "version", None), "cuda", None) or "N/A"  # pyright: ignore[reportAttributeAccessIssue]
    except Exception:
        cuda = "N/A"

    deps["CUDA"] = cuda

    sorted_deps = dict(sorted(deps.items(), key=lambda item: item[0].lower()))

    return sorted_deps


@app_router.get("/patchmatch_status", operation_id="get_patchmatch_status", status_code=200, response_model=bool)
async def get_patchmatch_status() -> bool:
    return PatchMatch.patchmatch_available()


class InvokeAIAppConfigWithSetFields(BaseModel):
    """InvokeAI App Config with model fields set"""

    set_fields: set[str] = Field(description="The set fields")
    config: InvokeAIAppConfig = Field(description="The InvokeAI App Config")


_CONFIG_WRITE_LOCK = Lock()


def _remove_nullable_default_from_schema(schema: dict[str, Any]) -> None:
    schema.pop("default", None)
    any_of = schema.pop("anyOf", None)
    if isinstance(any_of, list):
        non_null_schemas = [
            subschema for subschema in any_of if isinstance(subschema, dict) and subschema.get("type") != "null"
        ]
        if len(non_null_schemas) == 1:
            schema.update(non_null_schemas[0])


class UpdateAppGenerationSettingsRequest(BaseModel):
    """Writable generation-related app settings."""

    image_subfolder_strategy: IMAGE_SUBFOLDER_STRATEGY | None = Field(
        default=None,
        description="Strategy for organizing images into subfolders.",
        json_schema_extra=_remove_nullable_default_from_schema,
    )
    max_queue_history: int | None = Field(
        default=None,
        ge=0,
        description="Keep the last N completed, failed, and canceled queue items on startup. Set to 0 to prune all terminal items.",
    )

    @model_validator(mode="after")
    def validate_explicit_nulls(self) -> "UpdateAppGenerationSettingsRequest":
        if "image_subfolder_strategy" in self.model_fields_set and self.image_subfolder_strategy is None:
            raise ValueError("image_subfolder_strategy may not be null")
        return self


@app_router.get(
    "/runtime_config", operation_id="get_runtime_config", status_code=200, response_model=InvokeAIAppConfigWithSetFields
)
async def get_runtime_config() -> InvokeAIAppConfigWithSetFields:
    config = get_config()
    return InvokeAIAppConfigWithSetFields(set_fields=config.model_fields_set, config=config)


@app_router.patch(
    "/runtime_config",
    operation_id="update_runtime_config",
    status_code=200,
    response_model=InvokeAIAppConfigWithSetFields,
)
async def update_runtime_config(
    _: AdminUserOrDefault,
    changes: UpdateAppGenerationSettingsRequest = Body(description="Writable runtime configuration changes"),
) -> InvokeAIAppConfigWithSetFields:
    with _CONFIG_WRITE_LOCK:
        config = get_config()
        update_dict = changes.model_dump(exclude_unset=True)
        config.update_config(update_dict)

        if config.config_file_path.exists():
            persisted_config = load_and_migrate_config(config.config_file_path)
        else:
            persisted_config = DefaultInvokeAIAppConfig()

        persisted_config.update_config(update_dict)
        persisted_config.write_file(config.config_file_path)
        return InvokeAIAppConfigWithSetFields(set_fields=config.model_fields_set, config=config)


@app_router.get(
    "/logging",
    operation_id="get_log_level",
    responses={200: {"description": "The operation was successful"}},
    response_model=LogLevel,
)
async def get_log_level() -> LogLevel:
    """Returns the log level"""
    return LogLevel(ApiDependencies.invoker.services.logger.level)


@app_router.post(
    "/logging",
    operation_id="set_log_level",
    responses={200: {"description": "The operation was successful"}},
    response_model=LogLevel,
)
async def set_log_level(
    level: LogLevel = Body(description="New log verbosity level"),
) -> LogLevel:
    """Sets the log verbosity level"""
    ApiDependencies.invoker.services.logger.setLevel(level)
    return LogLevel(ApiDependencies.invoker.services.logger.level)


@app_router.delete(
    "/invocation_cache",
    operation_id="clear_invocation_cache",
    responses={200: {"description": "The operation was successful"}},
)
async def clear_invocation_cache() -> None:
    """Clears the invocation cache"""
    ApiDependencies.invoker.services.invocation_cache.clear()


@app_router.put(
    "/invocation_cache/enable",
    operation_id="enable_invocation_cache",
    responses={200: {"description": "The operation was successful"}},
)
async def enable_invocation_cache() -> None:
    """Clears the invocation cache"""
    ApiDependencies.invoker.services.invocation_cache.enable()


@app_router.put(
    "/invocation_cache/disable",
    operation_id="disable_invocation_cache",
    responses={200: {"description": "The operation was successful"}},
)
async def disable_invocation_cache() -> None:
    """Clears the invocation cache"""
    ApiDependencies.invoker.services.invocation_cache.disable()


@app_router.get(
    "/invocation_cache/status",
    operation_id="get_invocation_cache_status",
    responses={200: {"model": InvocationCacheStatus}},
)
async def get_invocation_cache_status() -> InvocationCacheStatus:
    """Clears the invocation cache"""
    return ApiDependencies.invoker.services.invocation_cache.get_status()
