# Python tests

- Read guidance for the production code under test. Follow existing suite placement (`tests/app/`, `tests/backend/`, or the owning root suite) and reuse appropriate fixtures from `conftest.py` and `fixtures/`.
- Protect observable behavior at the interface that owns it. A test should fail for a plausible regression, use independently derived expectations, and survive implementation refactors that preserve the contract.
- Avoid trivial type/constant/re-export tests, snapshots of incidental structure, duplicate coverage, implementation-shaped mock choreography, and benchmarks without a meaningful question. Remove obsolete tests.
- Reproduce bugs with a focused failing case when feasible. Add edge/failure cases where they protect real behavior, not every imaginable branch. Use names describing outcomes.
- Prefer real temporary SQLite/filesystem/tensor operations when they establish the behavior. Mock external services, expensive models, or unavailable hardware at an appropriate interface; never mock away the transaction, authorization, concurrency, or numerical behavior being checked.
- Isolate filesystem paths, databases, account identities, clocks, random seeds, environment changes, and network behavior. Clean up subprocesses, listeners, patches, and resources. Never use production model/database/output directories.
- Exercise rollback, revisions, cross-user isolation, retries, cancellation, resource bounds, and cleanup when affected. Frontend IndexedDB, Web Locks, focus, and rendering belong in webv2's real-browser tests.
- Run `uv run --no-sync pytest <test-paths>` from the root for focused checks; CI uses `uv run --no-sync pytest`. Configuration excludes `slow` by default. Use `-m slow` for selected slow tests or `-m ""` to include them deliberately.
- Hardware tests need explicit prerequisites and honest reporting of skips/unavailable devices. Passing mocked or CPU tests does not establish CUDA/ROCm/MPS/XPU behavior.
