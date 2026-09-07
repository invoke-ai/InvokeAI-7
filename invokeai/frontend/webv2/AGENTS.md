# Webv2

Read [ARCHITECTURE.md](ARCHITECTURE.md) before changing module ownership or interfaces. Read the affected owner-local README for lifecycle/persistence behavior. This is a React 19, Vite, Chakra UI 3, TanStack Query/Router, and @dnd-kit application; legacy web uses different libraries and commands.

## Ownership and state

- Follow `app -> workbench/features -> platform` and the executable policy in `src/architecture/`. App composes dependencies; Platform owns domain-neutral infrastructure; Features own domain behavior; Workbench owns the project aggregate, shell, and Canvas.
- Import Features through their registered top-level public entries. Do not deep-import another owner's implementation to follow generic advice against barrel imports. Pure cores stay independent of React, UI, and transport, including type-only dependencies.
- Production Canvas callers use `canvas-engine/api.ts`. Keep contracts with the owner of their invariants. Consult the ownership manifest before adding Workbench modules.
- Keep wire DTOs and persisted schemas behind explicit mappings/serializers. Do not grow compatibility re-exports into implementations or add architecture exceptions to make a check pass.
- TanStack Query owns backend read models; non-React runtimes own orchestration and lifecycle policy. Use stable, narrowly selected external-store snapshots instead of mirroring broad stores in component state.
- Preserve account/project isolation, stale-result fencing, revision conflicts, reconnect behavior, and start/dispose ownership. No process-wide mutable caches for per-account/project lifetimes.
- Read `src/workbench/projects/README.md` for persistence changes: backend authority, bounded recovery storage, cross-tab ownership, durable queue receipts, and explicit conflict decisions are behavioral contracts.

## React and product quality

- Add no direct `useEffect` calls. Derive values during render, handle actions in event handlers, fetch through Query, and subscribe through external-store adapters.
- Use the existing `@platform/react/useMountEffect` only for genuine mount/unmount registration with stable dependencies and complete cleanup. Do not hide changing dependencies in refs, introduce wrapper aliases, or use layout effects to evade this rule. Layout effects are reserved for required pre-paint DOM measurement.
- Migrate an existing effect when changing its behavior; do not sweep unrelated effects. When an identity changes, use the appropriate store/runtime lifecycle or deliberate keyed remount without losing user state accidentally.
- Reuse Platform UI controls, Chakra/theme tokens, icons, and established interaction patterns. Do not introduce a second styling system or adopt Next.js/SWR examples from generic skills.
- Finish loading, empty, error, disabled, and recovery states. Keep keyboard operation, visible focus, focus restoration, accessible names, and alternatives to pointer-only interactions intact.
- Maintain a dense, usable desktop layout across window sizes and zoom levels. Check overflow, long/localized text, selected/hover/active states, and theme consistency. Use existing localization conventions.
- Keep frequent interactions immediate and motion restrained, interruptible, and compatible with reduced-motion preferences. Specify transition properties; avoid animation that delays editing or is the only state cue.
- Inspect changed flows in a browser and provide relevant visual evidence. Browser tests and axe checks complement visual/interaction review rather than replacing it.

## Performance and validation

- Inspect affected render/subscription paths, large galleries/lists, pointer handlers, Canvas resources, lazy module loading, and request scheduling for related efficiency wins. Use existing virtualization and lazy boundaries; do not add memoization without an identified cost.
- Preserve resource disposal, bounded memory, account transitions, and responsive input. Measure material performance claims with the existing budgets and representative fixtures. Do not casually update goldens or baselines to hide regressions.
- Commands below run from this directory (or use `pnpm -C invokeai/frontend/webv2`). Install using `pnpm install --frozen-lockfile` with the existing lockfile.

| Change/check                          | Command                                                            |
| ------------------------------------- | ------------------------------------------------------------------ |
| Formatting, lint, types, architecture | `pnpm lint`                                                        |
| Focused behavior                      | `pnpm test <test-path>` or `pnpm test:browser <browser-test-path>` |
| Unit, Chromium, mock-backend fixtures | `pnpm test:all`                                                    |
| Architecture and browser performance  | `pnpm test:performance:architecture`                               |
| Project-file integration              | `pnpm test:project-files`                                          |
| Accessibility in a fresh build        | `pnpm test:accessibility`                                          |
| Milestone/release completion          | `pnpm check:release`                                               |

Install Chromium with `pnpm exec playwright install chromium` if missing (`--with-deps` in Linux CI). Unit tests are colocated `*.test.ts`/`*.test.tsx`; real-browser tests are `*.browser.test.ts`/`*.browser.test.tsx`. Test real IndexedDB, Web Locks, focus, pointer, and rendering behavior where mocks cannot establish correctness.

`check:release` includes lint, all tests, architecture performance/build, project-file journeys, and accessibility. Architecture inventories and performance reports go to ignored `artifacts/`; do not commit them. Run focused checks during development, then the completion gate before calling a code milestone ready. Documentation-only changes need formatting/link review, not unrelated application tests.
