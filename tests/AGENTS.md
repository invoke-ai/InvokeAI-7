# Python tests

- Read production-code guidance; use existing suites (`tests/app/`, `tests/backend/`, or the owning root suite) and appropriate `conftest.py`/`fixtures/` fixtures. UI copy and docs checks belong to their packages.
- Tests reading outside `tests/`, `scripts/`, or the Python package tree must add those paths to `.github/workflows/python-tests.yml` change filters so fixture-only changes trigger pytest.
- Name tests by outcome; cover meaningful edge/failure cases and survive behavior-preserving refactors. Prefer real temporary SQLite/filesystem/tensor operations. Mock external services, expensive models, or unavailable hardware without mocking the transaction, authorization, concurrency, or numerical behavior under test.
- Isolate paths, databases, accounts, clocks, seeds, environment, and network behavior. Clean up subprocesses, listeners, patches, and resources; never use production model/database/output directories.
- Cover affected rollback, revisions, cross-user isolation, retries, cancellation, bounds, and cleanup. IndexedDB, Web Locks, focus, and rendering belong in webv2 browser tests.
- Use root pytest commands. CI runs xdist workers per vCPU; `--dist loadfile` in `addopts` keeps each file on one worker, with arbitrary file assignment/order. Each file must establish its own process-global state (e.g. JWT secret) and pass alone; verify new files independently.
- Default tests assert behavior, not throughput/latency under runner contention. Generous hang ceilings are acceptable; CPU time tolerates contention better than wall time. Hardware/quiet-machine measurements require `slow`, excluded by default and CI. On development machines, use `-m slow` for that lane or `-m ""` for everything.
- State hardware prerequisites and skipped/unavailable devices. CPU/mocked passes do not establish CUDA/ROCm/MPS/XPU behavior.
