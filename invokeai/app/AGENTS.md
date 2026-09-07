# Application backend

## Ownership and contracts

- API routers validate requests, enforce authentication/authorization, and map service errors to HTTP responses. Services own domain behavior; storage implementations own persistence. Keep reusable policy out of route handlers.
- Inspect `api/dependencies.py`, the affected router, service base/default/storage implementations, and corresponding tests before changing a flow. Follow existing dependency and start/stop lifecycles rather than creating parallel global services.
- Authorize access to every account-owned resource on the server. Preserve ownership filtering for queries, writes, events, exports, and recovery; a UI guard is insufficient.
- Pydantic models, invocation fields/versions, HTTP DTOs, and socket events are contracts. Trace frontend and saved-workflow consumers before changing names, defaults, validation, or errors.
- API changes may require regenerating `frontend/web/openapi.json` and `frontend/web/src/services/api/schema.ts` (under `invokeai/`) even when the feature UI lives in webv2. Never hand-edit generated output. Read the legacy frontend guidance for commands.

## Persistence and lifecycle

- Preserve atomicity, revision checks, idempotency, and explicit conflict behavior. Inspect migrations and old-record readers before changing stored data; add migration/compatibility tests when needed.
- SQLite transactions are not automatically composable. Read `services/shared/sqlite/sqlite_database.py` and `services/project_records/project_records_sqlite.py`: nested service calls that open transactions can commit an outer operation prematurely. Keep multi-record writes under one transaction owner and pass its cursor where the design supports it.
- Preserve project/account isolation, bounded document sizes, queue admission/receipt semantics, and lost-response retry safety. Do not silently discard recovery data or turn conflicting writes into last-write-wins saves.
- Long-running work needs bounded concurrency, cancellation, appropriate timeouts/retries, and reliable cleanup of files, subprocesses, listeners, and task state. Avoid blocking the async server loop with CPU or blocking I/O work.
- Preserve file/path validation, existing remote-fetch protections, and sanitized errors. Tests and debugging must not modify a user's real models, database, outputs, or credentials.

## Efficiency and verification

- Examine affected queries for repeated lookups, unnecessary full scans/materialization, missing bounds, and excessive serialization. Use representative data and query counts/measurements before adding caches or indexes.
- Use real temporary SQLite storage for transaction, migration, revision, and ownership tests. Cover malformed input, cross-user access, cancellation, repeated requests, and partial failure when relevant; do not mock away the behavior being protected.
- Tests normally live under `tests/app/` or the existing owning suite in `tests/`; read `tests/AGENTS.md`. Run focused pytest plus root Ruff checks. Broaden to relevant service/router/invocation suites for a milestone.
- Graph execution changes should consult `services/shared/README.md` and test scheduling and invocation lifecycle through their owning interfaces.
- Report API/schema generation results, migration validation, and unavailable integration/hardware checks honestly. Root mypy is an additional diagnostic, not an existing CI requirement.
