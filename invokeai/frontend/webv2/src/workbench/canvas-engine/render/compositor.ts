/**
 * Composites a canvas document onto a target surface.
 *
 * Draws (in order): a clear + a viewport-filling checkerboard (the unbounded
 * plane's surround; omitted when the checkerboard is off), then each layer's
 * cached surface from bottom to top applying opacity / blend mode / transform,
 * and finally an optional staged-generation preview. Layers without a cache entry are
 * skipped — rasterization is the caller's job (see `rasterizers/` +
 * `layerCache.ts`); this module only draws what's already cached.
 *
 * Every pixel operation flows through the {@link RasterSurface} `ctx`, which
 * in tests is the recording stub, so composite order is assertable in node.
 * Zero React, zero import-time side effects.
 */

import type {
  CanvasBlendMode,
  CanvasDocumentContractV3,
  CanvasLayerContract,
  CanvasMaskFillContract,
} from '@workbench/canvas-engine/contracts';
import type { CanvasDiagnostics } from '@workbench/canvas-engine/diagnostics';
import type { SemanticLeaf } from '@workbench/canvas-engine/document-model/semanticLeaf';
import type { LayerDamage, Mat2d, Rect, Vec2 } from '@workbench/canvas-engine/types';

import { compileDocumentLeaves, lookupDocumentLeaf } from '@workbench/canvas-engine/document-model/documentModel';
import {
  ALL_OVERLAY_STACKS_SHOWN,
  planScreenComposition,
} from '@workbench/canvas-engine/document-model/screenComposition';
import { fromTRS, multiply } from '@workbench/canvas-engine/math/mat2d';
import { intersect, isEmpty, roundOut, transformBounds, union } from '@workbench/canvas-engine/math/rect';

import type { DerivedSurfaceCache } from './derivedSurfaceCache';
import type { GroupCompositeScope } from './groupCompositeScopes';
import type { LayerCacheEntry, LayerCacheStore } from './layerCache';
import type { RasterBackend, RasterSurface } from './raster';

import { renderControlTransparency } from './controlTransparency';
import { collectCompositedGroups, planGroupCompositeScopes } from './groupCompositeScopes';
import { colorizeMask } from './maskFill';

/** Screen-space size (px) of each checkerboard square for transparent backgrounds. */
export const CHECKERBOARD_SQUARE_PX = 8;

/**
 * CSS-zoom threshold at/above which image smoothing is disabled while
 * compositing. See {@link shouldSmoothAtZoom}.
 */
export const SMOOTHING_MAX_ZOOM = 1;

/**
 * Image-smoothing policy for compositing at a given CSS zoom.
 *
 * Smoothing is enabled only when the document is DOWN-scaled (`zoom < 1`) —
 * bilinear interpolation keeps a shrunk image clean. When zoomed IN
 * (`zoom >= 1`) the document is up-scaled to fill the screen; smoothing is
 * disabled so (a) pixels stay crisp when magnified — the behavior legacy pixel
 * editors adopt above ~1× — and (b) the browser skips the per-frame bilinear
 * interpolation of an ever-larger upscale, whose fill-rate cost is precisely
 * what grows with zoom. Nearest-neighbor upscaling is dramatically cheaper.
 */
export const shouldSmoothAtZoom = (zoom: number): boolean => zoom < SMOOTHING_MAX_ZOOM;

/** The two square colors of the transparency checkerboard. */
export interface CheckerColors {
  /** The base color, filled across the whole tile. */
  a: string;
  /** The alternating color, drawn on the tile's diagonal cells. */
  b: string;
}

/**
 * Fallback checkerboard colors when no theme tokens have been fed to the engine
 * (node tests, first frame before React resolves the tokens). Deliberately DARK,
 * theme-appropriate greys (in the spirit of the legacy dark transparency pattern)
 * so the indicator reads as "empty" against the dark workbench surface. In the
 * app these are replaced by resolved Chakra semantic tokens (see
 * `widgets/canvas/checkerColors.ts`).
 */
export const DEFAULT_CHECKER_COLORS: CheckerColors = { a: '#2a2a2a', b: '#363636' };

/**
 * Fallback tint alpha for a mask-bearing layer drawn WITHOUT a backend (a bare
 * {@link compositeDocument} call in a minimal test): the mask coverage is blitted
 * and a translucent flat fill laid over it. The real path (with a backend)
 * colorizes the mask alpha via `source-in` at the layer opacity, matching legacy.
 */
export const MASK_TINT_ALPHA = 0.5;

/** Dashed outline drawn around a staged-generation preview so it reads as pending, not committed. */
const STAGED_PREVIEW_OUTLINE_COLOR = '#3b82f6';
const STAGED_PREVIEW_OUTLINE_WIDTH = 2;
const STAGED_PREVIEW_OUTLINE_DASH = 6;

/** Optional inputs to {@link compositeDocument}. */
export interface CompositeOptions {
  /** Clips document layers to this document-space rect without clipping the background or staged preview. */
  clipRect?: Rect | null;
  /** A staged generation candidate to draw at its placement (document space). */
  stagedPreview?: { surface: RasterSurface; rect: Rect; opacity?: number } | null;
  /**
   * The cached checkerboard pattern tile (see {@link createCheckerboardTile}) to
   * fill the ENTIRE viewport with (the canvas is an unbounded plane — the checker
   * is the world, not a document backdrop). Omit or pass `null` to draw NO
   * checkerboard (the "checkerboard off" state) — the cleared surface then shows
   * the widget's themed `bg.inset` through it.
   */
  checkerboardTile?: RasterSurface | null;
  /**
   * Whether `imageSmoothingEnabled` is on for this composite's `drawImage`
   * blits (layer caches + staged preview). Defaults to `true` (the browser
   * default) so non-viewport callers are unaffected; the engine feeds
   * {@link shouldSmoothAtZoom} so zoomed-in frames composite crisp and cheap.
   */
  imageSmoothing?: boolean;
  /**
   * The regions this composite must repaint, each in its layer's local space.
   * When present, the clear, the checkerboard and every layer blit are clipped
   * to their union on screen and the rest of the target keeps the previous
   * frame — which is the difference between resampling a whole doc-sized layer
   * to screen scale and resampling a few hundred pixels of it.
   *
   * `undefined` or `null` repaints the whole target, which is what every caller
   * that cannot name its damage gets.
   */
  damage?: LayerDamage[] | null;
  /**
   * Transient per-layer transform overrides (a live move/transform preview): a
   * layer with an entry here is drawn through the overridden transform instead of
   * its committed one. `scaleX`/`scaleY`/`rotation` fall back to the committed
   * transform when absent (the move tool overrides only `x`/`y`). The mirror stays
   * untouched.
   */
  transformOverrides?: ReadonlyMap<
    string,
    { x: number; y: number; scaleX?: number; scaleY?: number; rotation?: number }
  > | null;
  /**
   * A layer id to SKIP entirely (draw nothing for it). Used while a text-edit
   * session is open: the contenteditable portal shows the layer's live text
   * instead, so drawing its committed pixels underneath would double up. `null`
   * (or absent) skips nothing.
   */
  skipLayerId?: string | null;
  /**
   * The raster backend, needed to colorize mask layers (an intermediate surface
   * holds the alpha stencil while the fill is composited `source-in`). When
   * absent, mask layers fall back to the flat-tint approximation
   * ({@link MASK_TINT_ALPHA}); the engine always supplies it.
   */
  backend?: RasterBackend | null;
  /**
   * Returns a cached repeat tile for a mask fill (style, colour), or `null` for a
   * solid fill (drawn directly). The engine caches tiles by `style:color` (like
   * the checkerboard). Absent ⇒ solid fills only.
   */
  maskPatternTile?: ((style: string, color: string) => RasterSurface | null) | null;
  /**
   * Opt-in for the regenerate-region overlays (a raster layer's own alpha
   * colorized above it while its region is enabled). STRICTLY display-time:
   * only screen frames and the Overview pass it — a composite whose pixels are
   * consumed (generation, extraction, color sampling, exports) must not, or the
   * tint becomes real content.
   */
  regionOverlays?: boolean;
  /**
   * Transient per-layer content previews (a non-destructive control-filter
   * preview): a layer with an entry here draws the preview surface at its returned
   * layer-local output rect, through the layer transform, INSTEAD of
   * its committed cache, so the document is untouched until the filter is applied.
   * `null`/absent ⇒ no previews.
   */
  layerPreviews?: ReadonlyMap<string, { surface: RasterSurface; rect: Rect }> | null;
  /**
   * Draws only this leaf and suppresses staged content and filter previews. A leaf the document
   * would not draw (disabled or hidden) stays undrawn even while isolated.
   */
  isolationLayerId?: string | null;
  /**
   * Returns a raster layer's ADJUSTED cache surface (brightness/contrast/
   * saturation/curves applied), or `null` when the layer has identity (or no)
   * adjustments — in which case the committed cache surface is drawn directly.
   * The engine wires this to a memoizing {@link
   * import('./adjustedSurfaceCache').AdjustedSurfaceCache} so the adjusted pixels
   * are NOT recomputed each frame (see that module). Only consulted for raster
   * layers; absent ⇒ adjustments are ignored (a bare test call draws raw pixels).
   */
  adjustedSurface?: ((layer: CanvasLayerContract, entry: LayerCacheEntry) => RasterSurface | null) | null;
  /** Shared memoized surfaces for mask and control display effects. */
  derivedSurfaces?: DerivedSurfaceCache | null;
  /**
   * A live floating selection: pixels cut out of `layerId` and held in flight.
   * They are drawn immediately ABOVE their own layer (the hole they left is
   * already in that layer's cache), inheriting its opacity and blend mode, so
   * the z-order is right by construction. `surface`/`rect` are LAYER-LOCAL, and
   * `matrix` is the float's layer-local transform — both are composed with the
   * layer's own matrix at draw time. `null`/absent ⇒ nothing in flight.
   */
  floatingSelection?: { layerId: string; surface: RasterSurface; rect: Rect; matrix: Mat2d } | null;
  /** Optional deterministic render counters; omitted in the normal zero-overhead path. */
  diagnostics?: CanvasDiagnostics | null;
  /**
   * An adjusted group's document-space composite (stack applied), `null` when
   * it has no drawable content; `excludeIds` members are left out for the
   * caller to draw separately. Absent ⇒ members draw flat.
   */
  groupSurface?:
    | ((
        scope: GroupCompositeScope,
        members: readonly SemanticLeaf[],
        memberMatrices: readonly Mat2d[],
        excludeIds: ReadonlySet<string>
      ) => { surface: RasterSurface; rect: Rect } | null)
    | null;
}

type Ctx = RasterSurface['ctx'];

/** Maps a document blend mode to the canvas `globalCompositeOperation`. Also used by `colorSample.ts`. */
export const blendToComposite = (mode: CanvasBlendMode): GlobalCompositeOperation =>
  mode === 'normal' ? 'source-over' : (mode as GlobalCompositeOperation);

const isIsolated = (opts: CompositeOptions): boolean =>
  opts.isolationLayerId !== null && opts.isolationLayerId !== undefined;

const setTransformFromMat = (ctx: Ctx, m: Mat2d): void => {
  ctx.setTransform(m.a, m.b, m.c, m.d, m.e, m.f);
};

const identityTransform = (ctx: Ctx): void => {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
};

const getEffectiveLayerMatrix = (leaf: SemanticLeaf, opts: CompositeOptions): Mat2d => {
  const override = opts.transformOverrides?.get(leaf.id);
  if (!override) {
    return leaf.worldTransform;
  }
  const { layer } = leaf;
  return fromTRS(
    { x: override?.x ?? layer.transform.x, y: override?.y ?? layer.transform.y },
    override?.rotation ?? layer.transform.rotation,
    override?.scaleX ?? layer.transform.scaleX,
    override?.scaleY ?? layer.transform.scaleY
  );
};

const isDefinitelyOffscreen = (
  leaf: SemanticLeaf,
  entry: LayerCacheEntry,
  view: Mat2d,
  target: RasterSurface,
  opts: CompositeOptions
): boolean => {
  const bounds = transformBounds(multiply(view, getEffectiveLayerMatrix(leaf, opts)), entry.rect);
  if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)) {
    return false;
  }
  return intersect(bounds, { height: target.height, width: target.width, x: 0, y: 0 }) === null;
};

/**
 * Builds a small, reusable two-tone checkerboard tile (a 2×2 grid of `squarePx`
 * cells) through the {@link RasterBackend} seam. The engine creates this ONCE and
 * feeds it back via {@link CompositeOptions.checkerboardTile}; each frame then
 * only `createPattern`s over it, so no per-cell fill loop runs per frame.
 */
export const createCheckerboardTile = (
  backend: RasterBackend,
  colors: CheckerColors = DEFAULT_CHECKER_COLORS,
  squarePx: number = CHECKERBOARD_SQUARE_PX
): RasterSurface => {
  const size = squarePx * 2;
  const tile = backend.createSurface(size, size);
  const ctx = tile.ctx;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, size, size);
  // Base color across the whole tile, then the alternating cells on the diagonal.
  ctx.fillStyle = colors.a;
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = colors.b;
  ctx.fillRect(0, 0, squarePx, squarePx);
  ctx.fillRect(squarePx, squarePx, squarePx, squarePx);
  return tile;
};

/**
 * Fills the ENTIRE viewport with the checkerboard pattern. The canvas is a
 * virtually infinite plane (like legacy): the checker IS the world surround, not
 * a document backdrop — the document rect is no longer a visual boundary, so the
 * contract's `background` field no longer renders. When no tile is provided the
 * checkerboard is off and the cleared surface shows the widget's `bg.inset`.
 *
 * The pattern is laid with the identity transform in place, anchoring its cells
 * to the screen (canvas) origin at a fixed pixel size — like legacy, which pins
 * the pattern to the stage — so it stays visually stable and never swims or
 * scales while panning/zooming.
 */
const drawBackground = (ctx: Ctx, tile: RasterSurface | null, bounds: Rect): void => {
  if (!tile) {
    // Checkerboard disabled: leave the cleared surface showing `bg.inset`.
    return;
  }
  const pattern = ctx.createPattern(tile.canvas, 'repeat');
  if (!pattern) {
    return;
  }
  ctx.fillStyle = pattern;
  ctx.fillRect(bounds.x, bounds.y, bounds.width, bounds.height);
};

/**
 * Resolves {@link CompositeOptions.damage} to the screen-space rect a frame may
 * confine itself to, or `null` for "repaint everything".
 *
 * Each region arrives in its layer's local space, so it is carried to the screen
 * through the same `view × layerMatrix` the layer itself is drawn with — which
 * keeps this correct for moved, scaled and rotated layers without the reporter
 * needing to know any of that. A region naming a layer that is no longer in the
 * document cannot be placed, so the frame falls back to a full repaint.
 *
 * The result is rounded outward and grown by a pixel: the layer blit is
 * antialiased at the seam, and a clip that lands mid-pixel would leave a hairline
 * of the previous frame behind.
 */
const resolveDamage = (
  doc: CanvasDocumentContractV3,
  view: Mat2d,
  target: RasterSurface,
  opts: CompositeOptions
): Rect | null => {
  const damage = opts.damage;
  if (!damage || damage.length === 0) {
    return null;
  }
  let accumulated: Rect | null = null;
  for (const region of damage) {
    const leaf = lookupDocumentLeaf(doc, region.layerId);
    if (!leaf) {
      return null;
    }
    const bounds = transformBounds(multiply(view, getEffectiveLayerMatrix(leaf, opts)), region.rect);
    accumulated = accumulated ? union(accumulated, bounds) : bounds;
  }
  if (!accumulated) {
    return null;
  }
  const grown = roundOut({
    height: accumulated.height + 2,
    width: accumulated.width + 2,
    x: accumulated.x - 1,
    y: accumulated.y - 1,
  });
  // A degenerate matrix would put NaN in here, and a NaN rect compares false
  // against every bound — which would quietly skip the frame's drawing rather
  // than widen it. Repaint everything instead.
  if (
    !Number.isFinite(grown.x) ||
    !Number.isFinite(grown.y) ||
    !Number.isFinite(grown.width) ||
    !Number.isFinite(grown.height)
  ) {
    return null;
  }
  return intersect(grown, { height: target.height, width: target.width, x: 0, y: 0 });
};

const isMaskLayer = (
  layer: CanvasLayerContract
): layer is Extract<CanvasLayerContract, { type: 'regional_guidance' | 'inpaint_mask' }> =>
  layer.type === 'regional_guidance' || layer.type === 'inpaint_mask';

/**
 * Draws a mask-bearing layer as a TINTED, TRANSLUCENT overlay. With a backend
 * available (the engine path) it colorizes the mask's alpha stencil with the
 * layer's fill colour/pattern (`source-in`) on an intermediate surface, then
 * blits that through the current (already transformed, `globalAlpha =
 * layer.opacity`) context — legacy's `source-in` compositing-rect technique.
 * Without a backend it falls back to blitting the coverage plus a flat
 * translucent fill.
 */
const drawMaskLayer = (
  ctx: Ctx,
  layer: Extract<CanvasLayerContract, { type: 'regional_guidance' | 'inpaint_mask' }>,
  surface: RasterSurface,
  sourceVersion: number,
  origin: Vec2,
  opts: CompositeOptions
): void => {
  const fill = layer.mask.fill;
  if (opts.backend) {
    const tile = opts.maskPatternTile ? opts.maskPatternTile(fill.style, fill.color) : null;
    const colorized = opts.derivedSurfaces
      ? opts.derivedSurfaces.get({
          create: (target) => colorizeMask(opts.backend!, surface, surface.width, surface.height, fill, tile, target),
          kind: 'mask-fill',
          layerId: layer.id,
          paramsKey: `${fill.style}:${fill.color}`,
          source: surface,
          sourceVersion,
        })
      : colorizeMask(opts.backend, surface, surface.width, surface.height, fill, tile);
    // The outer loop already set globalAlpha = layer.opacity; blit the colorized
    // overlay at the mask's local content origin.
    ctx.drawImage(colorized.canvas, origin.x, origin.y);
    return;
  }
  // Backend-less fallback (bare test call): coverage + flat translucent fill.
  ctx.drawImage(surface.canvas, origin.x, origin.y);
  ctx.globalAlpha = layer.opacity * MASK_TINT_ALPHA;
  ctx.fillStyle = fill.color;
  ctx.fillRect(origin.x, origin.y, surface.width, surface.height);
};

/**
 * Draws one cached layer through its transform, applying opacity/blend and any
 * transient transform override. Mask-bearing layers are colorized; everything
 * else is a straight blit of its content-sized cache surface.
 */
const drawCachedLayer = (
  ctx: Ctx,
  leaf: SemanticLeaf,
  entry: LayerCacheEntry,
  view: Mat2d,
  opts: CompositeOptions
): void => {
  const { layer } = leaf;
  ctx.save();
  ctx.globalAlpha = layer.opacity;
  ctx.globalCompositeOperation = blendToComposite(layer.blendMode);

  const layerMat = getEffectiveLayerMatrix(leaf, opts);
  setTransformFromMat(ctx, multiply(view, layerMat));

  // The cache surface holds pixels for `entry.rect` in layer-local space; draw
  // it at that local origin (offset paint/mask layers place their content off-zero).
  const origin = { x: entry.rect.x, y: entry.rect.y };
  const preview = isIsolated(opts) ? null : (opts.layerPreviews?.get(layer.id) ?? null);
  if (preview) {
    // Non-destructive filter preview: draw the full backend output at its
    // layer-local rect (through the already-applied layer transform), including
    // the same display-only control transparency effect used after commit.
    const displayPreview =
      layer.type === 'control' && layer.withTransparencyEffect && opts.backend
        ? opts.derivedSurfaces
          ? opts.derivedSurfaces.get({
              create: (target) =>
                renderControlTransparency(
                  opts.backend!,
                  preview.surface,
                  preview.surface.width,
                  preview.surface.height,
                  target
                ),
              kind: 'control-transparency',
              layerId: layer.id,
              paramsKey: 'preview',
              source: preview.surface,
              sourceVersion: 0,
            })
          : renderControlTransparency(opts.backend, preview.surface, preview.surface.width, preview.surface.height)
        : preview.surface;
    ctx.drawImage(displayPreview.canvas, preview.rect.x, preview.rect.y);
  } else if (isMaskLayer(layer)) {
    drawMaskLayer(ctx, layer, entry.surface, entry.version, origin, opts);
  } else if (layer.type === 'control' && layer.withTransparencyEffect && opts.backend) {
    // Display-only lightness→alpha effect (legacy `LightnessToAlphaFilter`): dark
    // areas of the control map drop out so underlying content shows through.
    const effect = opts.derivedSurfaces
      ? opts.derivedSurfaces.get({
          create: (target) =>
            renderControlTransparency(opts.backend!, entry.surface, entry.surface.width, entry.surface.height, target),
          kind: 'control-transparency',
          layerId: layer.id,
          paramsKey: 'committed',
          source: entry.surface,
          sourceVersion: entry.version,
        })
      : renderControlTransparency(opts.backend, entry.surface, entry.surface.width, entry.surface.height);
    ctx.drawImage(effect.canvas, origin.x, origin.y);
  } else {
    // Raster layers may carry non-destructive adjustments; the engine supplies a
    // memoized adjusted surface. The memo is keyed on the layer's cache version,
    // so it holds across idle frames but is deliberately missed on every tick of
    // a live stroke — that is what makes the stroke visible through the
    // adjustments. The miss refreshes only the written band. Fall back to the raw
    // cache when there are no adjustments or no provider.
    const adjusted = layer.type === 'raster' && opts.adjustedSurface ? opts.adjustedSurface(layer, entry) : null;
    ctx.drawImage((adjusted ?? entry.surface).canvas, origin.x, origin.y);
  }

  if (opts.regionOverlays && layer.type === 'raster' && layer.inpaint?.isEnabled && !preview && !isIsolated(opts)) {
    drawRegionCoverage(ctx, layer.id, layer.inpaint.fill, entry, opts);
  }

  ctx.restore();
};

/**
 * Draws a raster layer's regenerate region: the layer's OWN content alpha,
 * colorized like an inpaint mask and laid directly above the layer through the
 * same (already applied) transform. The mask IS the layer — every stroke,
 * erase, and transform updates it live, with nothing separate to persist.
 */
const drawRegionCoverage = (
  ctx: Ctx,
  layerId: string,
  fill: CanvasMaskFillContract,
  coverage: { surface: RasterSurface; rect: Rect; version: number },
  opts: CompositeOptions
): void => {
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = MASK_TINT_ALPHA;
  if (opts.backend) {
    const tile = opts.maskPatternTile ? opts.maskPatternTile(fill.style, fill.color) : null;
    const colorized = opts.derivedSurfaces
      ? opts.derivedSurfaces.get({
          create: (target) =>
            colorizeMask(
              opts.backend!,
              coverage.surface,
              coverage.surface.width,
              coverage.surface.height,
              fill,
              tile,
              target
            ),
          kind: 'region-fill',
          layerId,
          paramsKey: `${fill.style}:${fill.color}`,
          source: coverage.surface,
          sourceVersion: coverage.version,
        })
      : colorizeMask(opts.backend, coverage.surface, coverage.surface.width, coverage.surface.height, fill, tile);
    ctx.drawImage(colorized.canvas, coverage.rect.x, coverage.rect.y);
    return;
  }
  ctx.fillStyle = fill.color;
  ctx.drawImage(coverage.surface.canvas, coverage.rect.x, coverage.rect.y);
  ctx.fillRect(coverage.rect.x, coverage.rect.y, coverage.rect.width, coverage.rect.height);
};

/**
 * Draws the floating selection over the layer it was cut from. Its pixels are
 * layer-local, so they go through the layer's (possibly overridden) matrix and
 * then the float's own — never resampled into document space and back.
 */
const drawFloatingSelection = (
  ctx: Ctx,
  leaf: SemanticLeaf,
  view: Mat2d,
  opts: CompositeOptions,
  float: NonNullable<CompositeOptions['floatingSelection']>
): void => {
  const { layer } = leaf;
  ctx.save();
  ctx.globalAlpha = layer.opacity;
  ctx.globalCompositeOperation = blendToComposite(layer.blendMode);
  setTransformFromMat(ctx, multiply(multiply(view, getEffectiveLayerMatrix(leaf, opts)), float.matrix));
  ctx.drawImage(float.surface.canvas, float.rect.x, float.rect.y);
  ctx.restore();
};

/**
 * Composites `doc` onto `target`, using `caches` for each layer's pixels and
 * `view` as the document→screen transform.
 */
export const compositeDocument = (
  target: RasterSurface,
  doc: CanvasDocumentContractV3,
  caches: LayerCacheStore,
  view: Mat2d,
  opts: CompositeOptions = {}
): void => {
  const ctx = target.ctx;
  opts.diagnostics?.increment('compositeFrames');

  ctx.save();

  // Smoothing policy for all layer/staged `drawImage` blits below. Set once
  // under the outer save (inner per-layer save/restore preserves it). Off when
  // zoomed in keeps magnified pixels crisp and skips the costly bilinear upscale.
  ctx.imageSmoothingEnabled = opts.imageSmoothing ?? true;

  // Clear the target in screen space, then lay the checkerboard across it — the
  // canvas is an unbounded plane, so the checker is the world, not a document
  // backdrop. With the checkerboard off the cleared surface shows the widget's
  // themed `bg.inset` through it.
  //
  // When the frame declared its damage, both are confined to it and a clip keeps
  // every layer blit below inside it too, so the untouched majority of the target
  // simply keeps the previous frame's pixels. Damage that resolves to an empty
  // rect means nothing visible changed: leave the target entirely alone.
  identityTransform(ctx);
  const damageScreen = resolveDamage(doc, view, target, opts);
  if (damageScreen && isEmpty(damageScreen)) {
    ctx.restore();
    return;
  }
  const repaint: Rect = damageScreen ?? { height: target.height, width: target.width, x: 0, y: 0 };
  if (damageScreen) {
    ctx.beginPath();
    ctx.rect(damageScreen.x, damageScreen.y, damageScreen.width, damageScreen.height);
    ctx.clip();
  }
  ctx.clearRect(repaint.x, repaint.y, repaint.width, repaint.height);
  drawBackground(ctx, opts.checkerboardTile ?? null, repaint);

  if (opts.clipRect) {
    ctx.save();
    setTransformFromMat(ctx, view);
    ctx.beginPath();
    ctx.rect(opts.clipRect.x, opts.clipRect.y, opts.clipRect.width, opts.clipRect.height);
    ctx.clip();
  }

  // The plan lists the leaves to draw bottom first; the `stagedPreview` lands on top of every stack.
  const plan = planScreenComposition(compileDocumentLeaves(doc), {
    isolationLayerId: opts.isolationLayerId ?? null,
    showOverlayStacks: ALL_OVERLAY_STACKS_SHOWN,
  });
  // Isolation mode inspects raw members, so scopes are bypassed while active.
  const scopes =
    opts.groupSurface && !isIsolated(opts) ? planGroupCompositeScopes(plan.leaves, collectCompositedGroups(doc)) : [];
  let scopeIndex = 0;

  const drawLeafFlat = (leaf: SemanticLeaf): void => {
    opts.diagnostics?.increment('layersConsidered');
    const float = opts.floatingSelection?.layerId === leaf.id ? opts.floatingSelection : null;
    const entry = caches.get(leaf.id);
    // Skip layers with no cache or an empty content rect (a brand-new / cleared
    // paint / mask layer holds no pixels — nothing to draw). A float still draws:
    // its pixels are detached, so an emptied source layer must not hide them.
    if (!entry || entry.rect.width <= 0 || entry.rect.height <= 0) {
      if (float) {
        drawFloatingSelection(ctx, leaf, view, opts, float);
      }
      return;
    }
    if (isDefinitelyOffscreen(leaf, entry, view, target, opts) && !float) {
      opts.diagnostics?.increment('layersCulled');
      return;
    }
    drawCachedLayer(ctx, leaf, entry, view, opts);
    if (float) {
      drawFloatingSelection(ctx, leaf, view, opts, float);
    }
    opts.diagnostics?.increment('layersDrawn');
  };

  for (let index = 0; index < plan.leaves.length; index += 1) {
    const scope = scopeIndex < scopes.length ? scopes[scopeIndex]! : null;
    if (scope && index === scope.start) {
      const members = plan.leaves.slice(scope.start, scope.end);
      const matrices = members.map((member) => getEffectiveLayerMatrix(member, opts));
      // Skip targets and filter previews draw separately, without the group stack.
      const excluded = new Set<string>();
      for (const member of members) {
        if (member.id === opts.skipLayerId || opts.layerPreviews?.has(member.id)) {
          excluded.add(member.id);
        }
      }
      const result = opts.groupSurface!(scope, members, matrices, excluded);
      if (result) {
        ctx.save();
        ctx.globalAlpha = scope.opacity;
        ctx.globalCompositeOperation = blendToComposite(scope.blendMode);
        setTransformFromMat(ctx, view);
        ctx.drawImage(result.surface.canvas, result.rect.x, result.rect.y);
        ctx.restore();
        opts.diagnostics?.increment('layersDrawn');
        // A float whose member is in the composite draws alone.
        for (const member of members) {
          if (member.id === opts.skipLayerId) {
            continue;
          }
          if (excluded.has(member.id)) {
            drawLeafFlat(member);
          } else if (opts.floatingSelection?.layerId === member.id) {
            drawFloatingSelection(ctx, member, view, opts, opts.floatingSelection);
          }
        }
        // Region overlays are display-only, so they ride ABOVE the group
        // composite rather than being baked into (and staled with) its memo.
        for (let memberIndex = 0; opts.regionOverlays && memberIndex < members.length; memberIndex += 1) {
          const member = members[memberIndex]!;
          const { layer } = member;
          if (
            excluded.has(member.id) ||
            member.id === opts.skipLayerId ||
            layer.type !== 'raster' ||
            !layer.inpaint?.isEnabled
          ) {
            continue;
          }
          const memberEntry = caches.get(member.id);
          if (memberEntry && memberEntry.rect.width > 0 && memberEntry.rect.height > 0) {
            ctx.save();
            setTransformFromMat(ctx, multiply(view, matrices[memberIndex]!));
            drawRegionCoverage(ctx, layer.id, layer.inpaint.fill, memberEntry, opts);
            ctx.restore();
          }
        }
        index = scope.end - 1;
        scopeIndex += 1;
        continue;
      }
      scopeIndex += 1;
    }
    const leaf = plan.leaves[index]!;
    if (leaf.id === opts.skipLayerId) {
      continue;
    }
    drawLeafFlat(leaf);
  }

  if (opts.clipRect) {
    ctx.restore();
  }

  // Staged generation preview over its bbox (document space), with a subtle
  // dashed outline so the pending result reads distinctly from committed pixels.
  const staged = isIsolated(opts) ? null : opts.stagedPreview;
  if (staged) {
    ctx.save();
    setTransformFromMat(ctx, view);
    ctx.globalAlpha = staged.opacity ?? 1;
    ctx.drawImage(staged.surface.canvas, staged.rect.x, staged.rect.y, staged.rect.width, staged.rect.height);
    // Keep the outline visually constant regardless of zoom by dividing the
    // document-space stroke by the view scale (√det of the linear part).
    const viewScale = Math.sqrt(Math.abs(view.a * view.d - view.b * view.c)) || 1;
    ctx.globalAlpha = 1;
    ctx.strokeStyle = STAGED_PREVIEW_OUTLINE_COLOR;
    ctx.lineWidth = STAGED_PREVIEW_OUTLINE_WIDTH / viewScale;
    ctx.setLineDash([STAGED_PREVIEW_OUTLINE_DASH / viewScale, STAGED_PREVIEW_OUTLINE_DASH / viewScale]);
    ctx.strokeRect(staged.rect.x, staged.rect.y, staged.rect.width, staged.rect.height);
    ctx.setLineDash([]);
    ctx.restore();
  }

  ctx.restore();
};
