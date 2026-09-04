/**
 * Per-group memoized document-space composites of composited groups (adjustment
 * stack, opacity, or blend mode). Keyed on the scope shape plus every drawn
 * member's cache version, appearance, and effective matrix (so a transform
 * session inside a composited group rebuilds per tick); the scope's own
 * opacity/blend land at draw time and stay out of the key. Accepted tradeoff:
 * document resolution, so transformed members resample twice and zoom > 100%
 * upscales the group surface.
 */

import type { CanvasRasterLayerContractV2 } from '@workbench/canvas-engine/contracts';
import type { SemanticLeaf } from '@workbench/canvas-engine/document-model/semanticLeaf';
import type { LayerCacheEntry } from '@workbench/canvas-engine/render/layerCache';
import type { RasterSurface } from '@workbench/canvas-engine/render/raster';
import type { Mat2d, Rect } from '@workbench/canvas-engine/types';

import { multiply } from '@workbench/canvas-engine/math/mat2d';
import { roundOut, transformBounds, union } from '@workbench/canvas-engine/math/rect';
import { adjustmentsKey, applyAdjustments, isIdentityAdjustments } from '@workbench/canvas-engine/render/adjustments';
import { blendToComposite } from '@workbench/canvas-engine/render/compositor';

import type { GroupCompositeScope } from './groupCompositeScopes';

export interface GroupSurfaceResult {
  readonly surface: RasterSurface;
  /** Document-space placement of the surface. */
  readonly rect: Rect;
}

export interface GroupSurfaceDeps {
  createSurface(width: number, height: number): RasterSurface;
  getCacheEntry(layerId: string): LayerCacheEntry | undefined;
  /** The member's own adjusted pixels (its personal stack), or null for raw. */
  getAdjustedSurface(layer: CanvasRasterLayerContractV2, entry: LayerCacheEntry): RasterSurface | null;
}

export interface GroupSurfaceCache {
  /** Total RGBA bytes the cached group surfaces hold, for the memory budget. */
  byteSize(): number;
  get(
    scope: GroupCompositeScope,
    members: readonly SemanticLeaf[],
    memberMatrices: readonly Mat2d[],
    excludeIds: ReadonlySet<string>
  ): GroupSurfaceResult | null;
  /** Drops every cached group not named; call when document structure changes. */
  prune(liveGroupIds: ReadonlySet<string>): void;
  clear(): void;
}

const matKey = (m: Mat2d): string => `${m.a},${m.b},${m.c},${m.d},${m.e},${m.f}`;

// The frame composites with live session matrices while the overview composites
// the settled contract, so one group legitimately holds two keys at once; two
// slots stop those consumers evicting each other every tick.
const SLOTS_PER_GROUP = 2;

export const createGroupSurfaceCache = (deps: GroupSurfaceDeps): GroupSurfaceCache => {
  const cache = new Map<string, { key: string; result: GroupSurfaceResult }[]>();

  // A scope's OWN opacity/blend are applied by the consumer when the surface
  // lands, so they stay out of its shape key (an opacity scrub reuses the
  // surface); a CHILD scope's opacity/blend are baked in here by `drawRange`,
  // so children key with them.
  const childScopeKey = (scope: GroupCompositeScope): string =>
    `${scopeShapeKey(scope)}:${scope.opacity}:${scope.blendMode}`;
  const scopeShapeKey = (scope: GroupCompositeScope): string =>
    `${scope.id}@${scope.start}-${scope.end}:${adjustmentsKey(scope.adjustments)}(${scope.children
      .map(childScopeKey)
      .join(',')})`;

  const buildKey = (
    scope: GroupCompositeScope,
    members: readonly SemanticLeaf[],
    memberMatrices: readonly Mat2d[],
    excludeIds: ReadonlySet<string>
  ): string => {
    const memberKeys = members.map((leaf, index) => {
      const layer = leaf.layer;
      const entry = deps.getCacheEntry(leaf.id);
      const own = layer.type === 'raster' ? adjustmentsKey(layer.adjustments) : '-';
      return `${leaf.id}:${entry?.version ?? -1}:${layer.opacity}:${layer.blendMode}:${matKey(memberMatrices[index]!)}:${own}`;
    });
    return `${scopeShapeKey(scope)}|${memberKeys.join('|')}|x:${[...excludeIds].sort().join(',')}`;
  };

  /** Draws `[from, to)` (absolute plan indices, bottom first); `baseIndex` = absolute index of `members[0]`. */
  const drawRange = (
    ctx: RasterSurface['ctx'],
    view: Mat2d,
    members: readonly SemanticLeaf[],
    memberMatrices: readonly Mat2d[],
    excludeIds: ReadonlySet<string>,
    baseIndex: number,
    from: number,
    to: number,
    children: readonly GroupCompositeScope[]
  ): void => {
    let childIndex = 0;
    for (let i = from; i < to;) {
      const child = childIndex < children.length ? children[childIndex]! : null;
      if (child && i >= child.start && i < child.end) {
        const nested = build(child, members, memberMatrices, excludeIds, baseIndex);
        if (nested) {
          ctx.save();
          ctx.globalAlpha = child.opacity;
          ctx.globalCompositeOperation = blendToComposite(child.blendMode);
          ctx.setTransform(view.a, view.b, view.c, view.d, view.e, view.f);
          ctx.drawImage(nested.surface.canvas, nested.rect.x, nested.rect.y);
          ctx.restore();
        }
        i = child.end;
        childIndex += 1;
        continue;
      }
      const leaf = members[i - baseIndex]!;
      const matrix = memberMatrices[i - baseIndex]!;
      i += 1;
      if (excludeIds.has(leaf.id) || leaf.layer.type !== 'raster') {
        continue;
      }
      const entry = deps.getCacheEntry(leaf.id);
      if (!entry || entry.rect.width <= 0 || entry.rect.height <= 0) {
        continue;
      }
      const adjusted = deps.getAdjustedSurface(leaf.layer, entry);
      ctx.save();
      ctx.globalAlpha = leaf.layer.opacity;
      ctx.globalCompositeOperation = blendToComposite(leaf.layer.blendMode);
      const m = multiply(view, matrix);
      ctx.setTransform(m.a, m.b, m.c, m.d, m.e, m.f);
      ctx.drawImage((adjusted ?? entry.surface).canvas, entry.rect.x, entry.rect.y);
      ctx.restore();
    }
  };

  const build = (
    scope: GroupCompositeScope,
    members: readonly SemanticLeaf[],
    memberMatrices: readonly Mat2d[],
    excludeIds: ReadonlySet<string>,
    baseIndex: number
  ): GroupSurfaceResult | null => {
    let bounds: Rect | null = null;
    for (let i = scope.start; i < scope.end; i += 1) {
      const leaf = members[i - baseIndex]!;
      if (excludeIds.has(leaf.id) || leaf.layer.type !== 'raster') {
        continue;
      }
      const entry = deps.getCacheEntry(leaf.id);
      if (!entry || entry.rect.width <= 0 || entry.rect.height <= 0) {
        continue;
      }
      const memberBounds = transformBounds(memberMatrices[i - baseIndex]!, entry.rect);
      bounds = bounds === null ? memberBounds : union(bounds, memberBounds);
    }
    if (bounds === null) {
      return null;
    }
    const rect = roundOut(bounds);
    if (rect.width <= 0 || rect.height <= 0) {
      return null;
    }
    const surface = deps.createSurface(rect.width, rect.height);
    const ctx = surface.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);
    const view: Mat2d = { a: 1, b: 0, c: 0, d: 1, e: -rect.x, f: -rect.y };
    drawRange(ctx, view, members, memberMatrices, excludeIds, baseIndex, scope.start, scope.end, scope.children);
    // A group scoped only for opacity/blend has an identity stack: skip the
    // full-surface pixel round trip.
    if (!isIdentityAdjustments(scope.adjustments)) {
      const pixels = ctx.getImageData(0, 0, rect.width, rect.height);
      applyAdjustments(pixels, scope.adjustments);
      ctx.putImageData(pixels, 0, 0);
    }
    return { rect, surface };
  };

  return {
    byteSize: () => {
      let bytes = 0;
      for (const slots of cache.values()) {
        for (const { result } of slots) {
          bytes += result.rect.width * result.rect.height * 4;
        }
      }
      return bytes;
    },
    clear: () => cache.clear(),
    get: (scope, members, memberMatrices, excludeIds) => {
      const key = buildKey(scope, members, memberMatrices, excludeIds);
      const slots = cache.get(scope.id) ?? [];
      const hitIndex = slots.findIndex((slot) => slot.key === key);
      if (hitIndex >= 0) {
        const hit = slots[hitIndex]!;
        if (hitIndex > 0) {
          slots.splice(hitIndex, 1);
          slots.unshift(hit);
        }
        return hit.result;
      }
      const result = build(scope, members, memberMatrices, excludeIds, scope.start);
      if (result) {
        slots.unshift({ key, result });
        slots.length = Math.min(slots.length, SLOTS_PER_GROUP);
        cache.set(scope.id, slots);
      }
      // A null build (every member excluded or unrasterized) keeps existing
      // slots: keys fully determine validity, so a warm slot held by the other
      // consumer can only ever hit when genuinely valid.
      return result;
    },
    prune: (liveGroupIds) => {
      for (const id of cache.keys()) {
        if (!liveGroupIds.has(id)) {
          cache.delete(id);
        }
      }
    },
  };
};
