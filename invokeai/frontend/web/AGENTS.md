# Legacy frontend

Ordinary frontend feature and bugfix work targets `../webv2/`; read its guidance. Change legacy UI only when explicitly requested or a shared compatibility change requires it. The backend still selects legacy web without `--webv2`.

This package still owns `openapi.json`, generated `src/services/api/schema.ts`, and their generation tooling. Updating these for backend contract changes is expected and does not imply implementing the UI here.

## Commands

Run from this directory, with pnpm 10 and this package's lockfile:

- `pnpm lint`: legacy TypeScript, dependency-cycle, ESLint, Prettier, and unused-dependency checks.
- `pnpm test:no-watch`: legacy Vitest suite; colocate meaningful tests using existing conventions.
- `pnpm build`: legacy production build.
- From an activated repository Python environment, `python ../../../scripts/generate_openapi_schema.py > openapi.json` then `pnpm exec prettier --write openapi.json` regenerates the schema.
- From that same environment, `python ../../../scripts/generate_openapi_schema.py | pnpm typegen` regenerates frontend types. Use a shell with pipeline failure propagation and verify generator success; never hand-edit generated files.

Use root Ruff/pytest commands for associated Python changes. Do not apply webv2's Chakra version, @dnd-kit APIs, Oxc commands, or browser-test assumptions here. Preserve existing persisted-state migrations when changing legacy state behavior.

Shared review, scratch, performance, test-value, and commit rules apply. There is no mandatory work log, automatic commit, or requirement for named vendor-specific agents.
