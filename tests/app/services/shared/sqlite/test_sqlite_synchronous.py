"""The `synchronous` PRAGMA, and the config field that sets it.

`full` fsyncs on every commit and is SQLite's own default; `normal` under WAL trades the most recent
transactions on a power loss for much shorter commits. The default must not move, because that would
change the durability of every existing install without anyone asking for it.
"""

import pytest
from pydantic import ValidationError

from invokeai.app.services.config.config_default import InvokeAIAppConfig
from invokeai.app.services.shared.sqlite.sqlite_database import SqliteDatabase
from invokeai.backend.util.logging import InvokeAILogger

# What `PRAGMA synchronous` reports back, as documented by SQLite.
PRAGMA_VALUES = {"off": 0, "normal": 1, "full": 2, "extra": 3}


def _synchronous_of(db: SqliteDatabase) -> int:
    return int(db._conn.execute("PRAGMA synchronous;").fetchone()[0])


class TestTheConfigField:
    def test_the_default_is_full(self):
        # Anything else would silently reduce durability for every existing install on upgrade.
        assert InvokeAIAppConfig().db_synchronous == "full"

    def test_normal_is_accepted(self):
        assert InvokeAIAppConfig(db_synchronous="normal").db_synchronous == "normal"

    @pytest.mark.parametrize("value", ["off", "extra", "NORMAL", "", "1"])
    def test_other_sqlite_values_are_rejected(self, value):
        """`off` and `extra` are real SQLite settings, deliberately not offered: `off` can corrupt
        the database on an OS crash, and `extra` costs more than `full` for a guarantee this
        application does not need."""
        with pytest.raises(ValidationError):
            InvokeAIAppConfig(db_synchronous=value)


class TestThePragmaIsApplied:
    def test_the_default_leaves_sqlites_own_default_in_place(self, tmp_path):
        db = SqliteDatabase(db_path=tmp_path / "default.db", logger=InvokeAILogger.get_logger())
        assert _synchronous_of(db) == PRAGMA_VALUES["full"]

    @pytest.mark.parametrize("setting", ["full", "normal"])
    def test_each_setting_reaches_the_connection(self, tmp_path, setting):
        db = SqliteDatabase(
            db_path=tmp_path / f"{setting}.db",
            logger=InvokeAILogger.get_logger(),
            synchronous=setting,
        )
        assert _synchronous_of(db) == PRAGMA_VALUES[setting]

    def test_it_applies_to_an_in_memory_database_too(self):
        # The migrator and several tests use the in-memory path; it must not diverge.
        db = SqliteDatabase(db_path=None, logger=InvokeAILogger.get_logger(), synchronous="normal")
        assert _synchronous_of(db) == PRAGMA_VALUES["normal"]

    def test_wal_is_still_on(self, tmp_path):
        """`normal` is only safe against corruption *because* of WAL. If journal mode ever stopped
        being WAL, this setting would become a different trade than the one documented."""
        db = SqliteDatabase(db_path=tmp_path / "wal.db", logger=InvokeAILogger.get_logger(), synchronous="normal")
        assert db._conn.execute("PRAGMA journal_mode;").fetchone()[0].lower() == "wal"


class TestTheSettingReachesTheDatabase:
    """The gap that a config field and a working PRAGMA still leave open.

    Both halves can be correct while nothing connects them -- and that failure is silent: the app
    boots, every other test passes, and the setting simply does nothing. This happened once during
    development, which is why it is pinned rather than assumed.
    """

    @pytest.mark.parametrize("setting", ["full", "normal"])
    def test_init_db_passes_the_configured_value_through(self, monkeypatch, setting):
        from invokeai.app.services.shared.sqlite import sqlite_util

        seen: dict[str, object] = {}

        class _StubDatabase:
            def __init__(self, **kwargs):
                seen.update(kwargs)

        class _StubMigrator:
            def __init__(self, db):
                pass

            def register_migration(self, migration):
                pass

            def run_migrations(self):
                pass

        monkeypatch.setattr(sqlite_util, "SqliteDatabase", _StubDatabase)
        monkeypatch.setattr(sqlite_util, "SqliteMigrator", _StubMigrator)
        monkeypatch.setattr(sqlite_util, "build_migrations", lambda context: [])

        config = InvokeAIAppConfig(use_memory_db=True, db_synchronous=setting)
        sqlite_util.init_db(config=config, logger=InvokeAILogger.get_logger(), image_files=object())

        assert seen["synchronous"] == setting
