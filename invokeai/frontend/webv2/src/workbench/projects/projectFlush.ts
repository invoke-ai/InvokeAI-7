/**
 * What a push to the server actually achieved, as distinct from whether the call threw.
 *
 * Its own module rather than part of the sync engine: the caller that needs it, `library.ts`, is a
 * module the sync engine itself imports, so reaching back would be a cycle.
 *
 * A push swallows every failure because they are all recoverable — the document is cached and the
 * next save retries. But "recoverable" is not "done", and reading a project back after an
 * unacknowledged push is how an export ships someone's work minus the last ten minutes of it.
 */

/** The document the push was carrying, so a caller can compare it with what the engine recorded. */
export interface ProjectPushOutcomeBase {
  documentJson: string;
}

export type ProjectSchemaRefusal =
  | {
      kind: 'canvas';
      maxCanvasSchemaVersion: number;
      minimumCanvasSchemaVersion: number;
    }
  | {
      documentSchemaVersion: number;
      kind: 'document';
      maxDocumentSchemaVersion: number;
    }
  | { kind: 'invalid-server-document' };

export type ProjectPushOutcome =
  /** The server holds exactly this document. */
  | ({ kind: 'acknowledged' } & ProjectPushOutcomeBase)
  /**
   * This project id no longer holds our document: it was deleted or overwritten elsewhere, and the
   * local edits continue under a different id. Reading the id back would read a stranger's version.
   */
  | ({ kind: 'superseded' } & ProjectPushOutcomeBase)
  /** A newer client raised the project's compatibility floor. Local bytes remain cached. */
  | ({ kind: 'schema-refused'; refusal: ProjectSchemaRefusal } & ProjectPushOutcomeBase)
  /** Divergent server and local revisions await an explicit user decision. */
  | ({ kind: 'conflicted' } & ProjectPushOutcomeBase)
  /** The push did not land. The server still holds whatever it last acknowledged. */
  | ({ kind: 'unsynced' } & ProjectPushOutcomeBase);

/** Raised where an unacknowledged push must not be treated as a successful one. */
export class ProjectFlushError extends Error {
  readonly reason: Exclude<ProjectPushOutcome['kind'], 'acknowledged'>;

  constructor(reason: Exclude<ProjectPushOutcome['kind'], 'acknowledged'>) {
    super(
      reason === 'schema-refused'
        ? 'This project now requires a newer version of Invoke. Local changes remain in this browser.'
        : reason === 'conflicted'
          ? 'This project has conflicting local and server changes. Choose which version to keep.'
          : reason === 'unsynced'
            ? 'The project has changes that have not reached the server.'
            : 'The project was replaced on the server; the local edits continue under another id.'
    );
    this.name = 'ProjectFlushError';
    this.reason = reason;
  }
}

/** Refuse anything the server has not certainly acknowledged. See {@link readAcknowledgedProject}. */
export const assertProjectFlushed = (outcome: ProjectPushOutcome): void => {
  if (outcome.kind !== 'acknowledged') {
    throw new ProjectFlushError(outcome.kind);
  }
};
