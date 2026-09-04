/**
 * Client-generated project ids. The backend treats `(user_id, project_id)` as
 * the primary key and never mints ids itself, so uniqueness only has to hold
 * per user. UUID entropy keeps ids unique across devices, simultaneous
 * recoveries, and deleted-then-recreated projects without relying on clocks.
 */
export const createProjectId = (): string => `project-${globalThis.crypto.randomUUID()}`;
