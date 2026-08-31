# Frontend work targets webv2

All frontend feature and bugfix work in this repo is done in
**`invokeai/frontend/webv2`** — the frontend the running app actually serves.

`invokeai/frontend/web` is the legacy frontend: do not implement fixes or
features there, and do not assume reported UI bugs live in it. The two use
different DnD libraries (webv2: @dnd-kit; legacy web: pragmatic-drag-and-drop),
different styling stacks, and different lint/test commands.

webv2 commands (run from `invokeai/frontend/webv2/`): `pnpm lint`, `pnpm test`,
`pnpm run test:browser`. webv2 is git-tracked, so the usual branch + worktree
workflow applies to it.
