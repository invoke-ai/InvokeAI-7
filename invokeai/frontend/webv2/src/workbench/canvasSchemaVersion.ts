/** Oldest canvas document schema this build reads; earlier documents are refused, not migrated. */
export const MIN_SUPPORTED_CANVAS_SCHEMA_VERSION = 3;

/** Newest canvas document schema this build can safely read, edit, and write. */
export const MAX_SUPPORTED_CANVAS_SCHEMA_VERSION = 3;

/** Whether a project whose documents need at least `minimumCanvasSchemaVersion` can be opened here. */
export const isCanvasSchemaVersionSupported = (minimumCanvasSchemaVersion: number): boolean =>
  minimumCanvasSchemaVersion >= MIN_SUPPORTED_CANVAS_SCHEMA_VERSION &&
  minimumCanvasSchemaVersion <= MAX_SUPPORTED_CANVAS_SCHEMA_VERSION;

/** Compatibility floor for a new synced project until its document actually adopts a newer schema. */
export const DEFAULT_PROJECT_CANVAS_SCHEMA_VERSION = 3;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const requireDeclaredCanvasVersion = (canvas: unknown): number => {
  if (!isRecord(canvas) || !Number.isInteger(canvas.version) || (canvas.version as number) < 1) {
    throw new Error('A validated project document must declare a positive integer canvas schema version.');
  }

  return canvas.version as number;
};

/**
 * The compatibility floor implied by every canvas embedded in a canonical project document.
 *
 * Call this only after the project-ingestion gate has validated the live canvas and queue
 * snapshots. Throwing on malformed input is deliberate: silently defaulting here could publish a
 * document under a floor that an older client cannot actually read.
 */
export const getProjectCanvasSchemaRequirement = (document: Record<string, unknown>): number => {
  let requirement = requireDeclaredCanvasVersion(document.canvas);
  const queue = isRecord(document.queue) ? document.queue : null;
  const items = queue && Array.isArray(queue.items) ? queue.items : [];

  for (const item of items) {
    if (!isRecord(item) || !isRecord(item.snapshot)) {
      throw new Error('A validated project document must contain valid queue snapshots.');
    }

    requirement = Math.max(requirement, requireDeclaredCanvasVersion(item.snapshot.canvas));
  }

  return requirement;
};
