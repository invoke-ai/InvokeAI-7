# Legacy Invoke UI

This package preserves the previous frontend. Build it with `pnpm -C invokeai/frontend/web-legacy build` and launch with `invokeai-web --web-legacy`.

The default frontend lives in `../web/`. This package continues to own `openapi.json`, generated `src/services/api/schema.ts`, and schema-generation tooling while legacy remains supported.

Switching frontends does not migrate browser state or make new projects readable by legacy. Finish editing and close other editor tabs before switching. The legacy bootstrap releases the default frontend's service worker and this deployment's cached assets; localStorage, IndexedDB, and backend data remain intact.
