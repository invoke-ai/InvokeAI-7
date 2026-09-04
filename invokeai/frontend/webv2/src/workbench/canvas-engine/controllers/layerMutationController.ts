import type { DuplicateLayersResult } from '@workbench/canvas-engine/capabilities';
import type { CanvasDocumentContractV3, CanvasLayerContract } from '@workbench/canvas-engine/contracts';
import type { RasterMemoryReservationResult } from '@workbench/canvas-engine/controllers/rasterMemoryBudgetController';
import type { CanvasNodeInsertionAnchor } from '@workbench/canvas-engine/document/insertionAnchors';
import type { LayerStackKind } from '@workbench/canvas-engine/document/layerStacks';
import type { CanvasEditConcurrency } from '@workbench/canvas-engine/editConcurrency';
import type { History } from '@workbench/canvas-engine/history/history';
import type { CanvasProjectMutation } from '@workbench/canvas-engine/mutationContracts';
import type { PreparedLayerCacheReplacement } from '@workbench/canvas-engine/render/layerCache';
import type { RasterSurface } from '@workbench/canvas-engine/render/raster';
import type { Rect } from '@workbench/canvas-engine/types';

import { lookupDocumentLeaf } from '@workbench/canvas-engine/document-model/documentModel';
import {
  getDocumentIndex,
  getDocumentLayer,
  hasDocumentNode,
  isNodeAbsent,
  outermostNodes,
  type CanvasNodeEntry,
} from '@workbench/canvas-engine/document/documentIndex';
import { cloneSubtree, collectSubtreeLeaves } from '@workbench/canvas-engine/document/documentTree';
import { insertNodesAtAnchor } from '@workbench/canvas-engine/document/insertionAnchors';
import { haveSameStructure } from '@workbench/canvas-engine/document/layerStacks';

export type CapturedLayerCache = { pixels: RasterSurface; rect: Rect } | null | 'not-ready';

export type DuplicateLayerRasterPlan =
  | {
      readonly captureBytes: number;
      readonly initialReserveBytes: number;
      readonly replayReserveBytes: number;
      readonly retainForHistory: boolean;
      readonly type: 'capture';
    }
  | { readonly type: 'empty' }
  | { readonly type: 'reference' }
  | { readonly type: 'not-ready' };

type DuplicateRasterPreparationResult =
  | { readonly status: 'ready'; readonly layer: CanvasLayerContract }
  | { readonly status: 'not-ready' | 'over-budget' };

export interface LayerMutationControllerOptions {
  readonly concurrency: CanvasEditConcurrency;
  readonly captureCache: (layer: CanvasLayerContract, document: CanvasDocumentContractV3) => CapturedLayerCache;
  readonly captureInsertionAnchor: (stack: LayerStackKind, aboveId: string | null) => CanvasNodeInsertionAnchor;
  readonly captureRestoreAnchor: (nodeId: string) => CanvasNodeInsertionAnchor | null;
  readonly createLayerId: () => string;
  readonly discardPersisted: (layerId: string) => void;
  readonly dispatchPrepared: (
    action: CanvasProjectMutation,
    reducerAccepted: () => boolean,
    mirrorAccepted: () => boolean
  ) => void;
  readonly endBurst: () => void;
  readonly getDuplicateRasterPlan: (
    layer: CanvasLayerContract,
    document: CanvasDocumentContractV3
  ) => DuplicateLayerRasterPlan;
  readonly getDocument: () => CanvasDocumentContractV3 | null;
  readonly getEditRevision: () => number;
  readonly getReducerDocument: () => CanvasDocumentContractV3 | null;
  readonly getSelectedLayerIds: (document: CanvasDocumentContractV3) => readonly string[];
  readonly history: History;
  readonly hasPendingPixelWork: (layerId: string) => boolean;
  readonly installPrepared: (prepared: PreparedLayerCacheReplacement, persist?: boolean) => void;
  readonly needsPixelPersistence: (layer: CanvasLayerContract) => boolean;
  readonly preparePixels: (layerId: string, rect: Rect, pixels: RasterSurface) => PreparedLayerCacheReplacement;
  readonly publishSelectedLayerIds: (primaryId: string | null, selectedIds: readonly string[]) => void;
  readonly prepareDuplicateRasterSource: (layerId: string) => Promise<DuplicateRasterPreparationResult>;
  readonly pinDuplicateRasterSources: (layerIds: readonly string[]) => { release(): void };
  readonly reserve: (bytes: number) => RasterMemoryReservationResult;
  readonly scheduleDuplicateRasterization: (layerIds: readonly string[]) => void;
  readonly sameContract: (document: CanvasDocumentContractV3 | null, layer: CanvasLayerContract) => boolean;
  readonly trackDetached: (bytes: number) => { release(): void };
}

/** The outermost requested nodes in document order, or `null` when any id is absent or none is given. */
const duplicateRoots = (document: CanvasDocumentContractV3, ids: readonly string[]): CanvasNodeEntry[] | null => {
  const index = getDocumentIndex(document);
  const unique = [...new Set(ids)];
  if (unique.length === 0 || unique.some((id) => !index.byId.has(id))) {
    return null;
  }
  return outermostNodes(index, unique);
};

/** Owns failure-atomic copy and cross-type conversion mutations. */
export class LayerMutationController {
  private duplicateInFlight = false;

  constructor(private readonly options: LayerMutationControllerOptions) {}

  async duplicate(layerIds: readonly string[]): Promise<DuplicateLayersResult> {
    const o = this.options;
    const permit = o.concurrency.capturePermit();
    if (this.duplicateInFlight || !permit || !o.concurrency.canEdit() || o.concurrency.isGestureActive()) {
      return { status: 'busy' };
    }
    const document = o.getDocument();
    if (!document) {
      return { status: 'nothing' };
    }
    const roots = duplicateRoots(document, layerIds);
    if (!roots) {
      return { status: 'nothing' };
    }
    const sources = roots.flatMap((entry) => collectSubtreeLeaves(entry.node));
    const plans = sources.map((source) => o.getDuplicateRasterPlan(source, document));
    const notReadySources = sources.filter((_source, index) => plans[index]?.type === 'not-ready');
    if (notReadySources.length === 0) {
      return this.commitDuplicate(layerIds);
    }

    this.duplicateInFlight = true;
    const pinLease = o.pinDuplicateRasterSources(sources.map((source) => source.id));
    try {
      for (const source of notReadySources) {
        if (o.hasPendingPixelWork(source.id)) {
          return { status: 'not-ready' };
        }
        const prepared = await o.prepareDuplicateRasterSource(source.id);
        if (prepared.status !== 'ready') {
          return { status: prepared.status };
        }
        if (prepared.layer !== source) {
          return { status: 'stale' };
        }
      }
      if (!o.concurrency.isPermitCurrent(permit) || o.concurrency.isGestureActive() || o.getDocument() !== document) {
        return { status: 'stale' };
      }
      return this.commitDuplicate(layerIds);
    } finally {
      pinLease.release();
      this.duplicateInFlight = false;
    }
  }

  private commitDuplicate(layerIds: readonly string[]): DuplicateLayersResult {
    const o = this.options;
    if (!o.concurrency.canEdit() || o.concurrency.isGestureActive()) {
      return { status: 'busy' };
    }
    o.endBurst();
    const document = o.getDocument();
    if (!document) {
      return { status: 'nothing' };
    }
    const roots = duplicateRoots(document, layerIds);
    if (!roots) {
      return { status: 'nothing' };
    }
    const sources = roots.flatMap((entry) => collectSubtreeLeaves(entry.node));
    const plans = sources.map((source) => o.getDuplicateRasterPlan(source, document));
    let retainedBytes = 0;
    let reserveBytes = 0;
    for (const plan of plans) {
      if (plan.type === 'not-ready') {
        return { status: 'not-ready' };
      }
      if (plan.type === 'capture') {
        if (plan.retainForHistory) {
          retainedBytes += plan.captureBytes;
        }
        reserveBytes += plan.initialReserveBytes;
      }
    }
    const historyBytes = retainedBytes + sources.length * 256;
    if (!o.history.canRetain(historyBytes)) {
      return { status: 'over-budget' };
    }
    // Durable layer sources are immutable, so their one prepared cache is used
    // only for the initial insertion and can be reconstructed from the source
    // on redo. Live paint/mask pixels that have not reached a durable source
    // retain a separate immutable history capture and therefore need a second
    // live cache. This makes the common path one full-size copy while keeping
    // dirty pixels exact and every allocation inside the raster reservation.
    const reservation = o.reserve(reserveBytes);
    if (reservation.status === 'over-budget') {
      return { status: 'over-budget' };
    }
    try {
      const captures = sources.map((source, index) =>
        plans[index]?.type === 'capture' ? o.captureCache(source, document) : null
      );
      if (captures.some((capture) => capture === 'not-ready')) {
        return { status: 'not-ready' };
      }
      const existingIds = new Set(getDocumentIndex(document).byId.keys());
      const idMap = new Map<string, string>();
      const clones = roots.map((entry) => {
        const { node } = cloneSubtree(entry.node, o.createLayerId, idMap);
        return { ...node, name: `${entry.node.name} copy` };
      });
      const cloneLeaves = new Map(
        clones.flatMap((clone) => collectSubtreeLeaves(clone)).map((leaf) => [leaf.id, leaf])
      );
      // The cloned leaf for each pixel source, in source order; clones are fresh objects, so an
      // empty plan can strip their durable pixel reference in place before they enter the document.
      const duplicates = sources.map((source, index) => {
        const duplicate = cloneLeaves.get(idMap.get(source.id)!)!;
        if (plans[index]?.type === 'empty') {
          if (duplicate.type === 'raster' || duplicate.type === 'control') {
            if (duplicate.source.type === 'paint') {
              duplicate.source = { bitmap: null, type: 'paint' };
            }
          } else {
            duplicate.mask = { ...duplicate.mask, bitmap: null, offset: { x: 0, y: 0 } };
          }
        }
        return duplicate;
      });
      const createdIds = [...idMap.values()];
      if (createdIds.some((id) => existingIds.has(id)) || new Set(createdIds).size !== createdIds.length) {
        return { status: 'stale' };
      }
      const insertions = roots.map((entry, index) => ({
        anchor: o.captureInsertionAnchor(entry.stack, entry.node.id),
        nodes: [clones[index]!],
      }));
      const expectedStacks = insertions.reduce(
        (stacks, insertion) => insertNodesAtAnchor(stacks, insertion.anchor, insertion.nodes),
        document.stacks
      );
      const selectedLayerId =
        (document.selectedLayerId ? idMap.get(document.selectedLayerId) : undefined) ?? clones[0]!.id;
      const previousSelectedLayerId = document.selectedLayerId;
      const previousSelectedIds = [...o.getSelectedLayerIds(document)];
      const duplicateIds = clones.map((clone) => clone.id);
      const hasDuplicates = (candidate: CanvasDocumentContractV3 | null): boolean =>
        candidate?.selectedLayerId === selectedLayerId && haveSameStructure(candidate.stacks, expectedStacks);
      const hasOriginals = (candidate: CanvasDocumentContractV3 | null): boolean =>
        candidate?.selectedLayerId === previousSelectedLayerId && haveSameStructure(candidate.stacks, document.stacks);
      const applyPrepared = (
        prepared: readonly { duplicate: CanvasLayerContract; replacement: PreparedLayerCacheReplacement }[]
      ): void => {
        o.dispatchPrepared(
          {
            add: insertions,
            enabledUpdates: [],
            selectedLayerId,
            type: 'applyCanvasLayerStackMutation',
          },
          () => hasDuplicates(o.getReducerDocument()),
          () => hasDuplicates(o.getDocument())
        );
        prepared.forEach(({ duplicate, replacement }) => {
          o.installPrepared(replacement, o.needsPixelPersistence(duplicate));
        });
        o.publishSelectedLayerIds(selectedLayerId, duplicateIds);
      };
      const retainedCaptures = captures.map((capture, index) =>
        plans[index]?.type === 'capture' && plans[index].retainForHistory ? capture : null
      );
      const initialPrepared = captures.flatMap((capture, index) => {
        if (!capture || capture === 'not-ready') {
          return [];
        }
        const duplicate = duplicates[index]!;
        const plan = plans[index]!;
        return [
          {
            duplicate,
            replacement:
              plan.type === 'capture' && plan.retainForHistory
                ? o.preparePixels(duplicate.id, capture.rect, capture.pixels)
                : { layerId: duplicate.id, rect: capture.rect, surface: capture.pixels },
          },
        ];
      });
      applyPrepared(initialPrepared);
      initialPrepared.length = 0;
      captures.forEach((_capture, index) => {
        const plan = plans[index];
        if (plan?.type !== 'capture' || !plan.retainForHistory) {
          captures[index] = null;
        }
      });
      const detachedLease = retainedBytes > 0 ? o.trackDetached(retainedBytes) : null;
      const redo = (): void => {
        const current = o.getDocument();
        if (!current) {
          throw new Error('Canvas document is not ready to restore duplicated layers');
        }
        const replayPlans = sources.map((_source, index) => {
          const originalPlan = plans[index]!;
          if (originalPlan.type === 'capture' && originalPlan.retainForHistory) {
            return originalPlan;
          }
          return originalPlan.type === 'capture' ? ({ type: 'reference' } as const) : originalPlan;
        });
        const replayBytes = replayPlans.reduce(
          (total, plan) => total + (plan.type === 'capture' ? plan.replayReserveBytes : 0),
          0
        );
        const replayReservation = o.reserve(replayBytes);
        if (replayReservation.status === 'over-budget') {
          throw new Error('Not enough raster memory to restore duplicated layers');
        }
        try {
          const prepared = replayPlans.flatMap((plan, index) => {
            if (plan.type !== 'capture') {
              return [];
            }
            const duplicate = duplicates[index]!;
            const retained = retainedCaptures[index];
            if (!retained || retained === 'not-ready') {
              throw new Error('Layer pixels are not ready to restore duplicated layers');
            }
            return [
              {
                duplicate,
                replacement: o.preparePixels(duplicate.id, retained.rect, retained.pixels),
              },
            ];
          });
          applyPrepared(prepared);
          o.scheduleDuplicateRasterization(
            replayPlans.flatMap((plan, index) =>
              plan.type === 'reference' && plans[index]?.type === 'capture' ? [duplicates[index]!.id] : []
            )
          );
        } finally {
          replayReservation.lease.release();
        }
      };
      o.history.push({
        bytes: historyBytes,
        dispose: () => detachedLease?.release(),
        label: duplicates.length === 1 ? 'Duplicate layer' : 'Duplicate layers',
        redo,
        replayFailureAtomic: true,
        undo: () => {
          o.dispatchPrepared(
            {
              enabledUpdates: [],
              removeIds: duplicateIds,
              selectedLayerId: previousSelectedLayerId,
              type: 'applyCanvasLayerStackMutation',
            },
            () => hasOriginals(o.getReducerDocument()),
            () => hasOriginals(o.getDocument())
          );
          o.publishSelectedLayerIds(previousSelectedLayerId, previousSelectedIds);
        },
      });
      return { duplicateIds, selectedLayerId, status: 'duplicated' };
    } finally {
      reservation.lease.release();
    }
  }

  copy(label: string, sourceLayerId: string, layer: CanvasLayerContract, anchor: CanvasNodeInsertionAnchor): boolean {
    const o = this.options;
    if (!o.concurrency.canEdit() || o.concurrency.isGestureActive()) {
      return false;
    }
    o.endBurst();
    const document = o.getDocument();
    const source = getDocumentLayer(document, sourceLayerId);
    if (
      !document ||
      !source ||
      anchor.capturedEditRevision !== o.getEditRevision() ||
      hasDocumentNode(document, layer.id)
    ) {
      return false;
    }
    const captured = o.captureCache(source, document);
    if (captured === 'not-ready') {
      return false;
    }
    const selectedLayerId = document.selectedLayerId;
    const apply = (): void => {
      const prepared = captured ? o.preparePixels(layer.id, captured.rect, captured.pixels) : null;
      o.dispatchPrepared(
        {
          add: [{ anchor, nodes: [layer] }],
          enabledUpdates: [],
          selectedLayerId: layer.id,
          type: 'applyCanvasLayerStackMutation',
        },
        () =>
          o.getReducerDocument()?.selectedLayerId === layer.id &&
          getDocumentLayer(o.getReducerDocument(), layer.id) === layer,
        () => o.getDocument()?.selectedLayerId === layer.id && getDocumentLayer(o.getDocument(), layer.id) === layer
      );
      if (prepared) {
        o.installPrepared(prepared, o.needsPixelPersistence(layer));
      }
    };
    apply();
    o.history.push({
      bytes: captured ? captured.rect.width * captured.rect.height * 4 + 256 : 256,
      label,
      redo: apply,
      replayFailureAtomic: true,
      undo: () =>
        o.dispatchPrepared(
          { enabledUpdates: [], removeIds: [layer.id], selectedLayerId, type: 'applyCanvasLayerStackMutation' },
          () =>
            o.getReducerDocument()?.selectedLayerId === selectedLayerId &&
            isNodeAbsent(o.getReducerDocument(), layer.id),
          () => o.getDocument()?.selectedLayerId === selectedLayerId && isNodeAbsent(o.getDocument(), layer.id)
        ),
    });
    return true;
  }

  convert(label: string, expected: CanvasLayerContract, after: CanvasLayerContract): boolean {
    const o = this.options;
    if (
      !o.concurrency.canEdit() ||
      o.concurrency.isGestureActive() ||
      expected.id !== after.id ||
      expected.type === after.type
    ) {
      return false;
    }
    o.endBurst();
    const document = o.getDocument();
    const current = getDocumentLayer(document, expected.id);
    if (
      !document ||
      !current ||
      current !== expected ||
      current.type !== expected.type ||
      lookupDocumentLeaf(document, current.id)?.effectiveLocked !== false
    ) {
      return false;
    }
    const captured = o.captureCache(current, document);
    if (captured === 'not-ready') {
      return false;
    }
    // A conversion changes stacks, so undo carries the leaf back to its captured place.
    const restoreAnchor = o.captureRestoreAnchor(current.id) ?? undefined;
    const apply = (layer: CanvasLayerContract, anchor?: CanvasNodeInsertionAnchor): void => {
      const prepared = captured ? o.preparePixels(layer.id, captured.rect, captured.pixels) : null;
      o.dispatchPrepared(
        { anchor, id: layer.id, layer, targetType: layer.type, type: 'convertCanvasLayer' },
        () => o.sameContract(o.getReducerDocument(), layer),
        () => o.sameContract(o.getDocument(), layer)
      );
      try {
        o.discardPersisted(layer.id);
      } catch {
        /* Ancillary after reducer acceptance. */
      }
      if (prepared) {
        o.installPrepared(prepared, o.needsPixelPersistence(layer));
      }
    };
    const before = structuredClone(current);
    apply(after);
    o.history.push({
      bytes: captured ? captured.rect.width * captured.rect.height * 4 + 256 : 256,
      label,
      redo: () => apply(after),
      replayFailureAtomic: true,
      undo: () => apply(before, restoreAnchor),
    });
    return true;
  }

  dispose(): void {}
}
