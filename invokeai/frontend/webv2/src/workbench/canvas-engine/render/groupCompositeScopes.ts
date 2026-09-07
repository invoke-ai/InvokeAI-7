/**
 * Nested contiguous [start, end) scopes over a flat drawn list, one per
 * composited group — a group whose output must be built in isolation because it
 * carries a contributing adjustment stack, an opacity below 1, or a non-normal
 * blend mode. Both renderers consume the same shape. Relies on preorder (or its
 * reversal) keeping every subtree contiguous.
 */

import type {
  CanvasAdjustmentsContract,
  CanvasBlendMode,
  CanvasDocumentContractV3,
} from '@workbench/canvas-engine/contracts';

import { getDocumentIndex } from '@workbench/canvas-engine/document/documentIndex';
import { isGroupNode } from '@workbench/canvas-engine/document/documentTree';

import { isIdentityAdjustments } from './adjustments';

export interface GroupCompositeScope {
  readonly id: string;
  readonly adjustments: CanvasAdjustmentsContract;
  /** Applied when the scope's composite lands in its parent; 1 when absent on the group. */
  readonly opacity: number;
  /** Applied when the scope's composite lands in its parent; 'normal' when absent on the group. */
  readonly blendMode: CanvasBlendMode;
  /** Contiguous [start, end) index range over the flat drawn list. */
  readonly start: number;
  readonly end: number;
  /** Nested scopes, each fully inside [start, end), in list order. */
  readonly children: readonly GroupCompositeScope[];
}

export interface GroupCompositeFacts {
  readonly adjustments: CanvasAdjustmentsContract;
  readonly opacity: number;
  readonly blendMode: CanvasBlendMode;
}

const EMPTY_ADJUSTMENTS: CanvasAdjustmentsContract = [];

/** The raster-stack groups that must composite in isolation (disabled groups never draw). */
export const collectCompositedGroups = (
  document: CanvasDocumentContractV3
): ReadonlyMap<string, GroupCompositeFacts> => {
  const composited = new Map<string, GroupCompositeFacts>();
  for (const entry of getDocumentIndex(document).nodes) {
    if (entry.stack !== 'raster' || !isGroupNode(entry.node)) {
      continue;
    }
    const opacity = entry.node.opacity ?? 1;
    const blendMode = entry.node.blendMode ?? 'normal';
    const adjusted = entry.node.adjustments !== undefined && !isIdentityAdjustments(entry.node.adjustments);
    if (adjusted || opacity !== 1 || blendMode !== 'normal') {
      composited.set(entry.node.id, {
        adjustments: adjusted ? entry.node.adjustments! : EMPTY_ADJUSTMENTS,
        blendMode,
        opacity,
      });
    }
  }
  return composited;
};

interface OpenScope {
  id: string;
  adjustments: CanvasAdjustmentsContract;
  opacity: number;
  blendMode: CanvasBlendMode;
  start: number;
  children: GroupCompositeScope[];
}

/** Plans nested scopes over `items` (ancestor chains outermost-first); outermost scopes in list order. */
export const planGroupCompositeScopes = (
  items: readonly { readonly parentIds: readonly string[] }[],
  composited: ReadonlyMap<string, GroupCompositeFacts>
): readonly GroupCompositeScope[] => {
  if (composited.size === 0) {
    return [];
  }
  const roots: GroupCompositeScope[] = [];
  const open: OpenScope[] = [];

  const closeTo = (depth: number, end: number): void => {
    while (open.length > depth) {
      const scope = open.pop()!;
      const closed: GroupCompositeScope = { ...scope, end };
      const parent = open[open.length - 1];
      (parent ? parent.children : roots).push(closed);
    }
  };

  items.forEach((item, index) => {
    const chain = item.parentIds.filter((id) => composited.has(id));
    let shared = 0;
    while (shared < open.length && shared < chain.length && open[shared]!.id === chain[shared]) {
      shared += 1;
    }
    closeTo(shared, index);
    for (let depth = shared; depth < chain.length; depth += 1) {
      const id = chain[depth]!;
      const facts = composited.get(id)!;
      open.push({
        adjustments: facts.adjustments,
        blendMode: facts.blendMode,
        children: [],
        id,
        opacity: facts.opacity,
        start: index,
      });
    }
  });
  closeTo(0, items.length);
  return roots;
};
