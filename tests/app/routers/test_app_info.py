import os
from pathlib import Path
from typing import Any
from unittest.mock import Mock

import pytest
from fastapi.testclient import TestClient

from invokeai.app.api.dependencies import ApiDependencies
from invokeai.app.api.routers import app_info
from invokeai.app.api_app import app
from invokeai.app.services.auth.token_service import TokenData
from invokeai.app.services.config.config_default import get_config, load_and_migrate_config
from invokeai.app.services.image_files.image_subfolder_strategy import DateStrategy, create_subfolder_strategy
from invokeai.app.services.invoker import Invoker


@pytest.fixture(autouse=True, scope="module")
def client(invokeai_root_dir: Path) -> TestClient:
    os.environ["INVOKEAI_ROOT"] = invokeai_root_dir.as_posix()
    return TestClient(app)


class MockApiDependencies(ApiDependencies):
    invoker: Invoker

    def __init__(self, invoker: Invoker) -> None:
        self.invoker = invoker


def test_update_runtime_config_persists_image_subfolder_strategy(
    monkeypatch: Any, mock_invoker: Invoker, client: TestClient
) -> None:
    monkeypatch.setattr("invokeai.app.api.auth_dependencies.ApiDependencies", MockApiDependencies(mock_invoker))

    response = client.patch("/api/v1/app/runtime_config", json={"image_subfolder_strategy": "date"})

    assert response.status_code == 200
    assert response.json()["config"]["image_subfolder_strategy"] == "date"

    config_path = get_config().config_file_path
    file_config = load_and_migrate_config(config_path)
    assert file_config.image_subfolder_strategy == "date"
    assert "image_subfolder_strategy: date" in config_path.read_text()
    assert get_config().image_subfolder_strategy == "date"
    assert isinstance(create_subfolder_strategy(get_config().image_subfolder_strategy), DateStrategy)


def test_update_runtime_config_rejects_null_image_subfolder_strategy(
    monkeypatch: Any, mock_invoker: Invoker, client: TestClient
) -> None:
    monkeypatch.setattr("invokeai.app.api.auth_dependencies.ApiDependencies", MockApiDependencies(mock_invoker))

    response = client.patch("/api/v1/app/runtime_config", json={"image_subfolder_strategy": None})

    assert response.status_code == 422


def test_update_runtime_config_image_subfolder_strategy_schema() -> None:
    app.openapi_schema = None
    property_schema = app.openapi()["components"]["schemas"]["UpdateAppGenerationSettingsRequest"]["properties"][
        "image_subfolder_strategy"
    ]

    assert property_schema == {
        "description": "Strategy for organizing images into subfolders.",
        "enum": ["flat", "date", "type", "hash"],
        "title": "Image Subfolder Strategy",
        "type": "string",
    }


def test_update_runtime_config_reads_and_writes_yaml_under_config_lock(
    monkeypatch: Any, mock_invoker: Invoker, client: TestClient
) -> None:
    monkeypatch.setattr("invokeai.app.api.auth_dependencies.ApiDependencies", MockApiDependencies(mock_invoker))

    class TrackingLock:
        is_locked = False
        load_seen = False
        write_seen = False

        def __enter__(self) -> None:
            self.is_locked = True

        def __exit__(self, *_: Any) -> None:
            self.is_locked = False

    tracking_lock = TrackingLock()
    original_load_and_migrate_config = app_info.load_and_migrate_config
    original_write_file = app_info.InvokeAIAppConfig.write_file

    def load_and_migrate_config_with_lock_assertion(config_path: Path) -> Any:
        assert tracking_lock.is_locked
        tracking_lock.load_seen = True
        return original_load_and_migrate_config(config_path)

    def write_file_with_lock_assertion(
        config: app_info.InvokeAIAppConfig, dest_path: Path, as_example: bool = False
    ) -> None:
        assert tracking_lock.is_locked
        tracking_lock.write_seen = True
        return original_write_file(config, dest_path, as_example)

    monkeypatch.setattr(app_info, "_CONFIG_WRITE_LOCK", tracking_lock)
    monkeypatch.setattr(app_info, "load_and_migrate_config", load_and_migrate_config_with_lock_assertion)
    monkeypatch.setattr(app_info.InvokeAIAppConfig, "write_file", write_file_with_lock_assertion)

    response = client.patch("/api/v1/app/runtime_config", json={"max_queue_history": 10})

    assert response.status_code == 200
    assert tracking_lock.load_seen
    assert tracking_lock.write_seen


def test_update_runtime_config_rejects_non_admin_users(
    monkeypatch: Any, mock_invoker: Invoker, client: TestClient
) -> None:
    monkeypatch.setattr("invokeai.app.api.auth_dependencies.ApiDependencies", MockApiDependencies(mock_invoker))
    monkeypatch.setattr(mock_invoker.services.configuration, "multiuser", True)
    monkeypatch.setattr(
        "invokeai.app.api.auth_dependencies.verify_token",
        lambda _: TokenData(user_id="user-1", email="user@example.com", is_admin=False),
    )
    monkeypatch.setattr(mock_invoker.services.users, "get", Mock(return_value=Mock(is_active=True)))

    response = client.patch(
        "/api/v1/app/runtime_config",
        json={"image_subfolder_strategy": "date"},
        headers={"Authorization": "Bearer non-admin-token"},
    )

    assert response.status_code == 403
    assert response.json()["detail"] == "Admin privileges required"
