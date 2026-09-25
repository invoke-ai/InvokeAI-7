"""Client state and quarantined projects become media reference owners on existing databases."""

import json
import sqlite3
from logging import getLogger

from invokeai.app.services.shared.media_references import create_media_references_table
from invokeai.app.services.shared.sqlite_migrator.migrations.migration_2026_09_23_index_client_state_references import (
    build_migration,
)


def _database() -> sqlite3.Cursor:
    connection = sqlite3.connect(":memory:")
    cursor = connection.cursor()
    create_media_references_table(cursor)
    cursor.execute(
        "CREATE TABLE intermediates_browser_holds (user_id TEXT, lease_id TEXT, media_kind TEXT, media_name TEXT,"
        " expires_at TEXT);"
    )
    cursor.execute("CREATE TABLE client_state (user_id TEXT, key TEXT, value TEXT, PRIMARY KEY (user_id, key));")
    cursor.execute("CREATE TABLE users (user_id TEXT PRIMARY KEY);")
    cursor.executemany("INSERT INTO users VALUES (?);", [("alice",), ("bob",)])
    cursor.execute(
        "CREATE TABLE orphaned_projects_2026_08_06 (project_id TEXT, user_id TEXT, name TEXT, data TEXT,"
        " PRIMARY KEY (user_id, project_id));"
    )
    return cursor


def _rows(cursor: sqlite3.Cursor) -> set[tuple[str, ...]]:
    cursor.execute("SELECT owner_kind, user_id, owner_id, media_kind, media_name FROM media_references;")
    return set(cursor.fetchall())


def test_indexes_legacy_canvas_state_and_quarantined_projects_idempotently() -> None:
    cursor = _database()
    canvas = {"rasterLayers": [{"objects": [{"image": {"image_name": "layer.png"}}]}]}
    cursor.executemany(
        "INSERT INTO client_state VALUES (?, ?, ?);",
        [
            ("alice", "canvas", json.dumps(canvas)),
            ("alice", "ui", '{"panel": "left"}'),
            ("bob", "broken", "{"),
            ("departed", "canvas", json.dumps(canvas)),
        ],
    )
    cursor.execute(
        "INSERT INTO orphaned_projects_2026_08_06 VALUES ('p1', 'gone', 'Old', ?);",
        (json.dumps({"layers": [{"videoName": "clip.mp4"}]}),),
    )

    build_migration(getLogger(__name__)).callback(cursor)
    build_migration(getLogger(__name__)).callback(cursor)

    assert _rows(cursor) == {
        ("client_state", "alice", "canvas", "image", "layer.png"),
        ("quarantined_project", "gone", "p1", "video", "clip.mp4"),
    }
    cursor.execute("SELECT name FROM sqlite_master WHERE name = 'idx_intermediates_browser_holds_expires_at';")
    assert cursor.fetchone() is not None


def test_databases_without_either_table_migrate() -> None:
    connection = sqlite3.connect(":memory:")
    cursor = connection.cursor()
    create_media_references_table(cursor)
    cursor.execute("CREATE TABLE intermediates_browser_holds (media_kind TEXT, media_name TEXT, expires_at TEXT);")

    build_migration(getLogger(__name__)).callback(cursor)

    assert _rows(cursor) == set()
