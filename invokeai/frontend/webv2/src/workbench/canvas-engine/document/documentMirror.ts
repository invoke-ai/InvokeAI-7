import type {
  CanvasDocumentContractV3,
  CanvasLayerContract,
  CanvasStagingAreaContractV2,
  CanvasStateContractV3,
} from '@workbench/canvas-engine/contracts';

import { getDocumentIndex, type CanvasDocumentIndex, type CanvasNodeEntry } from './documentIndex';
import { isGroupNode } from './documentTree';

/** The minimal store shape the mirror depends on (a superset of `WorkbenchStore`). */
export interface DocumentMirrorStore {
  getCanvasState?(): CanvasStateContractV3 | null;
  getState?(): { projects: readonly { id: string; canvas: CanvasStateContractV3 }[] };
  subscribe(listener: () => void): () => void;
}

/** Callbacks fired when the mirrored document changes. */
export interface DocumentMirrorCallbacks {
  /**
   * One or more leaves were added, removed, replaced, or had their effective state changed by an
   * ancestor (the `changed` ids). `sourceChanged` is the subset whose rasterization source
   * (`source` for raster/control layers, `mask.bitmap` for guidance/mask layers) changed, plus any
   * newly added leaf: the leaves whose cached pixels are now stale. A property, transform, or
   * ancestor-flag change reports the id in `changed` but not in `sourceChanged`, so the engine
   * keeps its raster cache.
   */
  onLayersChanged(changed: string[], sourceChanged: string[]): void;
  /**
   * Leaves changed ONLY by an ancestor group's adjustment stack: recomposite
   * without `onLayersChanged`'s destructive reactions (float and pixel-edit
   * cancellation).
   */
  onLayersRecomposite?(ids: string[]): void;
  /** The forests were restructured without any leaf changing: recomposite with the new order. */
  onLayerOrderChanged(): void;
  /** The document was replaced wholesale (dims/background change, appear/disappear) — full invalidate. */
  onDocumentReplaced(): void;
  /** The generation bounding box changed. */
  onBboxChanged(): void;
  /** The staging area changed. */
  onStagingChanged(): void;
  /**
   * The document's `selectedLayerId` changed. A selection-only edit produces a new `document`
   * object with the same `stacks` reference and an equal `bbox`, so none of the other callbacks
   * fire for it. The engine uses it to repaint selection-derived chrome and to close per-layer
   * transient sessions, since the layer panel is the sole authority on which node is active.
   */
  onSelectionChanged?(selectedLayerId: string | null): void;
}

/** The imperative mirror handle. */
export interface DocumentMirror {
  /** The current mirrored document, or `null` if the project is gone. */
  getDocument(): CanvasDocumentContractV3 | null;
  /** Synchronously reconciles from store state when ordinary notification was interrupted. */
  refresh(): void;
  /** Removes the store subscription. */
  dispose(): void;
}

type Bbox = CanvasDocumentContractV3['bbox'];

const bboxEqual = (a: Bbox, b: Bbox): boolean =>
  a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

/**
 * The reference whose change requires re-rasterizing a leaf's cache: the `source` for
 * raster/control layers, the mask's `bitmap` for guidance/mask layers. The reducer preserves this
 * reference across a property-only edit, so comparing it distinguishes a genuine source swap from
 * an opacity/blend/lock/visibility/rename/nudge tweak. For masks the reference is the bitmap, not
 * the whole `mask`: the cache holds only the alpha stencil, so a fill-only change must not clear
 * unflushed strokes that live only in the cache.
 */
const rasterSourceRef = (layer: CanvasLayerContract): unknown =>
  layer.type === 'raster' || layer.type === 'control' ? layer.source : layer.mask.bitmap;

const effectiveKey = (entry: CanvasNodeEntry): string =>
  `${entry.ancestorsEnabled ? 1 : 0}${entry.ancestorsLocked ? 1 : 0}${entry.ancestorsHidden ? 1 : 0}`;

interface ForestDiff {
  changed: string[];
  sourceChanged: string[];
  /** Ancestor-adjustment fan-out only; disjoint from `changed`. */
  recompositeOnly: string[];
  restructured: boolean;
}

/**
 * Diffs two forests by leaf identity and ancestor-effective state. A leaf whose object is unchanged
 * but whose ancestors now enable, lock or hide it differently is reported as changed, because its
 * rendered contribution changed even though nothing about it did.
 */
const diffForests = (prev: CanvasDocumentIndex, next: CanvasDocumentIndex): ForestDiff => {
  const changed = new Set<string>();
  const sourceChanged = new Set<string>();
  const recompositeOnly = new Set<string>();
  // Preorder: a changed group's id is collected before its leaves are visited.
  const adjustedGroups = new Set<string>();
  let restructured = false;
  for (const entry of next.nodes) {
    const before = prev.byId.get(entry.node.id);
    if (!before) {
      restructured = true;
      if (!isGroupNode(entry.node)) {
        changed.add(entry.node.id);
        sourceChanged.add(entry.node.id);
      }
      continue;
    }
    if (before.parentId !== entry.parentId || before.order !== entry.order) {
      restructured = true;
    }
    if (isGroupNode(entry.node)) {
      const beforeGroup = before.node as typeof entry.node;
      if (
        before.node !== entry.node &&
        (beforeGroup.adjustments !== entry.node.adjustments ||
          beforeGroup.opacity !== entry.node.opacity ||
          beforeGroup.blendMode !== entry.node.blendMode)
      ) {
        adjustedGroups.add(entry.node.id);
      }
      continue;
    }
    if (before.node !== entry.node) {
      changed.add(entry.node.id);
      if (rasterSourceRef(before.node as CanvasLayerContract) !== rasterSourceRef(entry.node)) {
        sourceChanged.add(entry.node.id);
      }
    } else if (effectiveKey(before) !== effectiveKey(entry)) {
      changed.add(entry.node.id);
    } else if (entry.path.some((ancestorId) => adjustedGroups.has(ancestorId))) {
      recompositeOnly.add(entry.node.id);
    }
  }
  for (const entry of prev.nodes) {
    if (!next.byId.has(entry.node.id)) {
      restructured = true;
      if (!isGroupNode(entry.node)) {
        changed.add(entry.node.id);
      }
    }
  }
  return {
    changed: [...changed],
    recompositeOnly: [...recompositeOnly].filter((id) => !changed.has(id)),
    restructured,
    sourceChanged: [...sourceChanged],
  };
};

/**
 * Creates a document mirror bound to `projectId`. Subscribes immediately and seeds the last-seen
 * references from the current state, so no spurious callback fires on creation.
 */
export const createDocumentMirror = (
  store: DocumentMirrorStore,
  projectIdOrCallbacks: string | DocumentMirrorCallbacks,
  maybeCallbacks?: DocumentMirrorCallbacks
): DocumentMirror => {
  const projectId = typeof projectIdOrCallbacks === 'string' ? projectIdOrCallbacks : null;
  const callbacks = typeof projectIdOrCallbacks === 'string' ? maybeCallbacks : projectIdOrCallbacks;
  if (!callbacks) {
    throw new Error('DocumentMirror callbacks are required.');
  }
  const selectCanvas = (): CanvasStateContractV3 | null =>
    store.getCanvasState?.() ??
    (projectId === null
      ? null
      : (store.getState?.().projects.find((project) => project.id === projectId)?.canvas ?? null));

  let lastDoc: CanvasDocumentContractV3 | null = selectCanvas()?.document ?? null;
  let lastRevision: number = selectCanvas()?.documentRevision ?? 0;
  let lastStaging: CanvasStagingAreaContractV2 | null = selectCanvas()?.stagingArea ?? null;

  const handleChange = (): void => {
    const canvas = selectCanvas();
    const doc = canvas?.document ?? null;
    const revision = canvas?.documentRevision ?? 0;
    const staging = canvas?.stagingArea ?? null;

    if (doc !== lastDoc) {
      const prevDoc = lastDoc;
      const prevRevision = lastRevision;
      const prevSelectedLayerId = prevDoc?.selectedLayerId ?? null;
      lastDoc = doc;
      lastRevision = revision;

      if (!prevDoc || !doc) {
        callbacks.onDocumentReplaced();
      } else if (
        revision !== prevRevision ||
        prevDoc.width !== doc.width ||
        prevDoc.height !== doc.height ||
        prevDoc.background !== doc.background
      ) {
        callbacks.onDocumentReplaced();
      } else {
        if (prevDoc.stacks !== doc.stacks) {
          const diff = diffForests(getDocumentIndex(prevDoc), getDocumentIndex(doc));
          if (diff.changed.length > 0) {
            callbacks.onLayersChanged(diff.changed, diff.sourceChanged);
          } else if (diff.restructured) {
            callbacks.onLayerOrderChanged();
          }
          if (diff.recompositeOnly.length > 0) {
            callbacks.onLayersRecomposite?.(diff.recompositeOnly);
          }
        }
        if (!bboxEqual(prevDoc.bbox, doc.bbox)) {
          callbacks.onBboxChanged();
        }
      }

      const selectedLayerId = doc?.selectedLayerId ?? null;
      if (selectedLayerId !== prevSelectedLayerId) {
        callbacks.onSelectionChanged?.(selectedLayerId);
      }
    }

    if (staging !== lastStaging) {
      lastStaging = staging;
      callbacks.onStagingChanged();
    }
  };

  const unsubscribe = store.subscribe(handleChange);

  return {
    dispose: unsubscribe,
    getDocument: () => lastDoc,
    refresh: handleChange,
  };
};
