# Project persistence

The backend project record is authoritative. Writes use `expected_revision`; a divergent revision or remotely deleted project requires an explicit user decision. Editing can continue while that decision is pending. Saving a copy reuses one reserved identity through `createProjectSettled`, including after a lost response.

`ProjectDocumentV2` allowlists editable document fields. Queue runs, events, graph history, and undo are not project documents. Documents are limited to 32 MiB of UTF-8 JSON on both sides of the API. The workflow library is the durable home for saved workflows; undo and capped events are session-only.

## Browser recovery

- Account-owned IndexedDB stores only unacknowledged project drafts, active queue runs, receipt acknowledgements, and bounded recall values. Clean server documents are not mirrored.
- Draft generations fence acknowledgements. Draft writer ownership and cross-tab notifications prevent one editor from overwriting another editor's unacknowledged work.
- Queue ownership uses Web Locks. Journal writes precede submission; backend receipts make retries safe after lost responses. Accepted IDs must be durable before their receipt can expire. Fresh runs that never reached browser storage use best-effort terminal acknowledgement instead.
- Completed, failed, and cancelled runs retain exact recall values in an LRU cache, capped at 500 entries / 32 MiB. Eviction removes recall convenience, not project data or active-run recovery.
- Projects with journal entries remain reachable even if another tab saved an empty session. Automatic reopening is bounded; remaining entries can be opened, exported as queue-recovery JSON, or explicitly discarded. Discarding local recovery does not cancel backend work.
- Browser-storage failures do not block backend project loads or saves. Recovery warnings distinguish degraded local durability from successful server persistence.

## Intentional cutover

The old workbench mirror, sync map, and refused-project localStorage keys are deleted on initialization. Their contents are not migrated. Export any needed browser-only work with the old build before upgrading.

Cold-start offline editing is not supported. When the backend cannot load, the unavailable screen provides retry and local draft/run exports. Conflicted or schema-refused drafts are retained until explicitly resolved or deleted; they are never silently evicted.

## Verification

Run `pnpm lint`, `pnpm test`, `pnpm test:browser`, and `pnpm run test:performance:build` from webv2. Queue receipt tests also cover backend admission, account isolation, project deletion, partial acceptance, and idempotent retries. Browser tests exercise actual IndexedDB transactions and Web Locks.
