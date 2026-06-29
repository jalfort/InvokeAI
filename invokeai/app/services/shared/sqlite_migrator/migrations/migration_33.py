"""Migration 33: Remove external-API model records.

A previous version of this fork shipped upstream's external-API image-generation
feature (Gemini, OpenAI gpt-image, Alibaba/Seedream). Those "models" were stored
as regular rows in the `models` table with a discriminator of `base = 'external'`
(and `format = 'external_api'`), but no file on disk.

That feature has been removed, along with the `ExternalApiModelConfig` model-config
type and its `BaseModelType.External` / `ModelFormat.ExternalApi` enum values. Any
leftover external rows would now fail to parse against the model-config discriminated
union and break model listing on startup.

This migration deletes those rows (and any `model_relationships` links that reference
them) so existing databases continue to load cleanly. It is a no-op on databases that
never installed an external model.
"""

import sqlite3

from invokeai.app.services.shared.sqlite_migrator.sqlite_migrator_common import Migration


class Migration33Callback:
    """Delete external-API model records left over from the removed external-generation feature."""

    def __call__(self, cursor: sqlite3.Cursor) -> None:
        self._delete_external_models(cursor)

    def _delete_external_models(self, cursor: sqlite3.Cursor) -> None:
        # The `base` and `format` columns are virtual, generated from the JSON config blob.
        cursor.execute(
            "SELECT id FROM models WHERE base = 'external' OR format = 'external_api';",
        )
        external_ids = [row[0] for row in cursor.fetchall()]
        if not external_ids:
            return

        placeholders = ",".join("?" for _ in external_ids)

        # Remove relationship links referencing these models first (defensive — ON DELETE
        # CASCADE should handle this, but only if the foreign keys are intact).
        cursor.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='model_relationships';",
        )
        if cursor.fetchone() is not None:
            cursor.execute(
                f"DELETE FROM model_relationships "
                f"WHERE model_key_1 IN ({placeholders}) OR model_key_2 IN ({placeholders});",
                external_ids + external_ids,
            )

        cursor.execute(
            f"DELETE FROM models WHERE id IN ({placeholders});",
            external_ids,
        )


def build_migration_33() -> Migration:
    """Builds the migration object for migrating from version 32 to version 33.

    This migration removes external-API model records left over from the removed
    external-generation feature so the database loads cleanly without the external
    model-config type.
    """
    return Migration(
        from_version=32,
        to_version=33,
        callback=Migration33Callback(),
    )
