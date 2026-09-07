import type {
  CanvasDocumentCapability,
  CanvasLayerCapability,
  CanvasDocumentModel,
  DocumentRefusal,
  PrepareEditResult,
  StructuralCommitResult,
} from '@workbench/canvas-engine/api';
import type { TFunction } from 'i18next';

import { useNotify } from '@workbench/useNotify';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Explains a refused structural edit. `busy` stays silent because an in-flight operation already
 * disables the controls that could reach here; every other refusal drops the edit and says so.
 */
export const reportStructuralCommit = (
  result: StructuralCommitResult,
  reportError: (title: string, message: string) => void,
  t: TFunction
): void => {
  const title = t('widgets.canvas.structural.failed');
  switch (result.status) {
    case 'committed':
    case 'busy':
      return;
    case 'gesture-active':
      reportError(title, t('widgets.canvas.structural.gestureActive'));
      return;
    case 'not-ready':
      reportError(title, t('widgets.canvas.structural.notReady'));
      return;
    case 'stale':
      reportError(title, t('widgets.canvas.structural.stale'));
      return;
    case 'dispatch-rejected':
      reportError(title, t('widgets.canvas.structural.rejected'));
      return;
    case 'postcondition-failed':
      switch (result.recovered) {
        case 'reverted':
          reportError(title, t('widgets.canvas.structural.reverted'));
          return;
        case 'reverted-unmirrored':
          reportError(title, t('widgets.canvas.structural.unmirrored'));
          return;
        case 'unreverted':
          reportError(title, t('widgets.canvas.structural.unverified'));
      }
  }
};

/** A widget-side structural commit that reports the refusals the user needs to hear about. */
/** The engine surface a prepared edit needs: the document model and the transaction. */
export interface CanvasPreparedEngine {
  readonly document: Pick<CanvasDocumentCapability, 'model'>;
  readonly layers: Pick<CanvasLayerCapability, 'commitPrepared'>;
}

export type PreparedCommitOutcome =
  | StructuralCommitResult
  | { status: 'refused'; refusal: DocumentRefusal }
  | { status: 'unchanged' };

/** Prepares an edit against the engine's current model and commits it; refusals and no-ops never dispatch. */
export const commitPreparedEdit = (
  engine: CanvasPreparedEngine | null,
  label: string,
  prepare: (model: CanvasDocumentModel) => PrepareEditResult
): PreparedCommitOutcome => {
  const model = engine?.document.model() ?? null;
  if (!engine || !model) {
    return { status: 'not-ready' };
  }
  const result = prepare(model);
  switch (result.status) {
    case 'prepared':
      return engine.layers.commitPrepared(label, result.edit);
    case 'unchanged':
      return result;
    default:
      return { refusal: result, status: 'refused' };
  }
};

const REFUSAL_KEYS: Record<DocumentRefusal['status'], string> = {
  'invalid-target': 'widgets.canvas.structural.refusedInvalidTarget',
  locked: 'widgets.canvas.structural.refusedLocked',
  missing: 'widgets.canvas.structural.refusedMissing',
  unsupported: 'widgets.canvas.structural.refusedUnsupported',
  'wrong-type': 'widgets.canvas.structural.refusedWrongType',
};

const INVALID_TARGET_KEYS: Partial<Record<Extract<DocumentRefusal, { status: 'invalid-target' }>['reason'], string>> = {
  cycle: 'widgets.canvas.structural.refusedCycle',
  'depth-exceeded': 'widgets.canvas.structural.refusedDepth',
  'node-limit': 'widgets.canvas.structural.refusedNodeLimit',
  'not-siblings': 'widgets.canvas.structural.refusedNotSiblings',
};

const refusalKey = (refusal: DocumentRefusal): string =>
  (refusal.status === 'invalid-target' ? INVALID_TARGET_KEYS[refusal.reason] : undefined) ??
  REFUSAL_KEYS[refusal.status];

export const reportPreparedCommit = (
  outcome: PreparedCommitOutcome,
  reportError: (title: string, message: string) => void,
  t: TFunction
): void => {
  if (outcome.status === 'unchanged') {
    return;
  }
  if (outcome.status === 'refused') {
    reportError(t('widgets.canvas.structural.failed'), t(refusalKey(outcome.refusal)));
    return;
  }
  reportStructuralCommit(outcome, reportError, t);
};

export type PreparedCommit = (
  label: string,
  prepare: (model: CanvasDocumentModel) => PrepareEditResult
) => PreparedCommitOutcome;

/** A widget-side prepared commit that reports every refusal the user needs to hear about. */
export const usePreparedCommit = (engine: CanvasPreparedEngine | null): PreparedCommit => {
  const notify = useNotify();
  const { t } = useTranslation();

  return useCallback(
    (label, prepare) => {
      const outcome = commitPreparedEdit(engine, label, prepare);

      reportPreparedCommit(outcome, notify.error, t);
      return outcome;
    },
    [engine, notify, t]
  );
};
