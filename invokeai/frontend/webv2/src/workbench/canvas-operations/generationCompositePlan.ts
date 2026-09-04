import type {
  CanvasControlLayerContract,
  CanvasDocumentContractV3,
  CanvasInpaintMaskLayerContract,
  CanvasLayerContract,
  CanvasLayerSourceContract,
  CanvasRasterLayerContractV2,
  CanvasRegionalGuidanceLayerContract,
} from '@workbench/canvas-engine/api';

import {
  adjustmentsKey,
  getBaseRasterContentBounds,
  getCompositeLayerBounds,
  planBaseRasterComposite,
} from '@workbench/canvas-engine/api';
import { compileDocumentLeaves } from '@workbench/canvas-engine/document-model/documentModel';
import { hasControlLayerContent, hasRegionalGuidanceMaskContent } from '@workbench/canvasLayerContent';

import type {
  CompositeEntry,
  CompositeLayerRef,
  CompositeMaskLayerRef,
  CompositePlan,
  Rect,
} from './generationContracts';

import { DEFAULT_MASK_DENOISE_LIMIT } from './generationContracts';

/** A stable string identifying a source's pixels (its asset name, or an empty sentinel). */
const sourceRefOf = (source: CanvasLayerSourceContract): string => {
  switch (source.type) {
    case 'image':
      return `image:${source.image.imageName}`;
    case 'paint':
      return source.bitmap ? `paint:${source.bitmap.imageName}` : 'paint:empty';
    default:
      return `${source.type}:unsupported`;
  }
};

/** Serializes a rect into a compact, deterministic key fragment. */
const rectKey = (rect: Rect): string => `${rect.x},${rect.y},${rect.width},${rect.height}`;

/** Serializes a layer ref's pixel-determining fields into a key fragment. */
const layerKey = (ref: CompositeLayerRef): string => {
  const t = ref.transform;
  const o = ref.contentOffset;
  return [
    ref.id,
    ref.sourceRef,
    o.x,
    o.y,
    t.x,
    t.y,
    t.scaleX,
    t.scaleY,
    t.rotation,
    ref.opacity,
    ref.blendMode,
    ref.adjustments ? adjustmentsKey(ref.adjustments) : '-',
  ].join(':');
};

export { getBaseRasterContentBounds, getCompositeLayerBounds, planBaseRasterComposite };

/** The contributing layers, in flat order, narrowed to the ones that satisfy `hasContent`. */
const contributingLayers = <T extends CanvasLayerContract>(
  document: CanvasDocumentContractV3,
  hasContent: (layer: CanvasLayerContract) => layer is T
): T[] =>
  compileDocumentLeaves(document)
    .filter((leaf) => leaf.contributionEnabled)
    .map((leaf) => leaf.layer)
    .filter(hasContent);

const isInpaintMaskWithContent = (layer: CanvasLayerContract): layer is CanvasInpaintMaskLayerContract =>
  layer.type === 'inpaint_mask' && layer.mask.bitmap !== null;

/**
 * A raster layer whose regenerate region is enabled and whose source can both
 * hold pixels and rasterize: the layer's OWN content alpha joins the inpaint
 * mask. Invoke flushes paint uploads before planning, so a stroked layer always
 * carries its bitmap; polygon shapes have no rasterizer and would fail the
 * snapshot capture, so they never enter the plan.
 */
const isRegionRasterWithContent = (layer: CanvasLayerContract): layer is CanvasRasterLayerContractV2 =>
  layer.type === 'raster' &&
  layer.inpaint?.isEnabled === true &&
  !(layer.source.type === 'shape' && layer.source.kind === 'polygon') &&
  (layer.source.type !== 'paint' || layer.source.bitmap !== null);

/** JSON with recursively sorted object keys, so equal sources always serialize identically. */
const stableSourceKey = (value: unknown): string =>
  JSON.stringify(value, (_key, entry: unknown) =>
    entry && typeof entry === 'object' && !Array.isArray(entry)
      ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => (a < b ? -1 : 1)))
      : entry
  );

/**
 * A region ref's pixel-identity fragment. Unlike the base plan — where
 * parametric sources never reach a dedupe key — a region can sit on a text,
 * shape, or gradient layer, so their pixel-determining fields must be part of
 * the key or an edited layer would reuse the previous mask upload.
 */
const regionSourceRef = (source: CanvasLayerSourceContract): string => {
  switch (source.type) {
    case 'image':
    case 'paint':
      return `region:${sourceRefOf(source)}`;
    default:
      return `region:${stableSourceKey(source)}`;
  }
};

/** The native content rect of a region raster's source (layer-local), mirroring the base composite. */
const regionContentRect = (
  layer: CanvasRasterLayerContractV2,
  document: CanvasDocumentContractV3
): { width: number; height: number; x: number; y: number } => {
  const { source } = layer;
  if (source.type === 'image') {
    return { height: source.image.height, width: source.image.width, x: 0, y: 0 };
  }
  if (source.type === 'paint' && source.bitmap) {
    const offset = source.offset ?? { x: 0, y: 0 };
    return { height: source.bitmap.height, width: source.bitmap.width, x: offset.x, y: offset.y };
  }
  return { height: document.height, width: document.width, x: 0, y: 0 };
};

/** Projects a region-bearing raster layer into an inpaint-mask contribution (its alpha, full denoise). */
const toRegionMaskRef = (
  layer: CanvasRasterLayerContractV2,
  document: CanvasDocumentContractV3
): CompositeMaskLayerRef => {
  const rect = regionContentRect(layer, document);
  return {
    attributeValue: DEFAULT_MASK_DENOISE_LIMIT,
    contentOffset: { x: rect.x, y: rect.y },
    contentSize: { height: rect.height, width: rect.width },
    id: layer.id,
    sourceRef: regionSourceRef(layer.source),
    transform: {
      rotation: layer.transform.rotation,
      scaleX: layer.transform.scaleX,
      scaleY: layer.transform.scaleY,
      x: layer.transform.x,
      y: layer.transform.y,
    },
  };
};

const isControlLayerWithContent = (layer: CanvasLayerContract): layer is CanvasControlLayerContract =>
  layer.type === 'control' && hasControlLayerContent(layer);

const isRegionalGuidanceWithMask = (layer: CanvasLayerContract): layer is CanvasRegionalGuidanceLayerContract =>
  layer.type === 'regional_guidance' && hasRegionalGuidanceMaskContent(layer);

/** The native content rect of a mask layer's persisted bitmap (layer-local, at its offset). */
const maskContentRect = (
  layer: CanvasInpaintMaskLayerContract
): { width: number; height: number; x: number; y: number } => {
  const { bitmap, offset } = layer.mask;
  if (bitmap) {
    const o = offset ?? { x: 0, y: 0 };
    return { height: bitmap.height, width: bitmap.width, x: o.x, y: o.y };
  }
  return { height: 0, width: 0, x: 0, y: 0 };
};

/** Projects a mask layer into a grayscale-composite contribution with its resolved attribute value. */
const toMaskLayerRef = (layer: CanvasInpaintMaskLayerContract, attributeValue: number): CompositeMaskLayerRef => {
  const rect = maskContentRect(layer);
  return {
    attributeValue,
    contentOffset: { x: rect.x, y: rect.y },
    contentSize: { height: rect.height, width: rect.width },
    id: layer.id,
    sourceRef: layer.mask.bitmap ? `mask:${layer.mask.bitmap.imageName}` : 'mask:empty',
    transform: {
      rotation: layer.transform.rotation,
      scaleX: layer.transform.scaleX,
      scaleY: layer.transform.scaleY,
      x: layer.transform.x,
      y: layer.transform.y,
    },
  };
};

/** Serializes a mask layer ref (adds `attributeValue` to the pixel-determining key). */
const maskLayerKey = (ref: CompositeMaskLayerRef): string => {
  const t = ref.transform;
  const o = ref.contentOffset;
  return [ref.id, ref.sourceRef, o.x, o.y, t.x, t.y, t.scaleX, t.scaleY, t.rotation, ref.attributeValue].join(':');
};

/** Derives the stable identity key for a grayscale mask entry. */
const deriveMaskKey = (kind: string, bbox: Rect, layers: CompositeMaskLayerRef[]): string =>
  `${kind}|${rectKey(bbox)}|${layers.map(maskLayerKey).join('|')}`;

/**
 * Plans the composites required to invoke `document` over `bbox`:
 * - one `base-raster` entry (the initial image);
 * - one `inpaint-mask` entry (grayscale denoise-limit mask) when enabled inpaint
 *   masks with content exist — an absent OR DISABLED `denoise` modifier resolves
 *   to the legacy default (1.0, full denoise) — or when a contributing raster
 *   layer carries an enabled regenerate region (its own content alpha joins the
 *   mask at full denoise);
 * - one `noise-mask` entry when at least one such mask carries an ENABLED
 *   `noise` modifier (absent and disabled are equivalent, mirroring legacy —
 *   they must NOT be treated as noise 0). Regions never add noise.
 */
export const planComposites = (document: CanvasDocumentContractV3, bbox: Rect): CompositePlan => {
  const entries: CompositeEntry[] = [planBaseRasterComposite(document, bbox)];

  const maskLayers = contributingLayers(document, isInpaintMaskWithContent);
  const regionRefs = contributingLayers(document, isRegionRasterWithContent).map((layer) =>
    toRegionMaskRef(layer, document)
  );

  if (maskLayers.length > 0 || regionRefs.length > 0) {
    const denoiseRefs = [
      ...maskLayers.map((layer) =>
        toMaskLayerRef(layer, layer.denoise?.isEnabled ? layer.denoise.limit : DEFAULT_MASK_DENOISE_LIMIT)
      ),
      ...regionRefs,
    ];
    entries.push({
      bbox,
      key: deriveMaskKey('inpaint-mask', bbox, denoiseRefs),
      kind: 'inpaint-mask',
      layers: [],
      maskLayers: denoiseRefs,
    });

    const noiseRefs = maskLayers
      .filter((layer) => layer.noise?.isEnabled)
      .map((layer) => toMaskLayerRef(layer, layer.noise!.level));

    if (noiseRefs.length > 0) {
      entries.push({
        bbox,
        key: deriveMaskKey('noise-mask', bbox, noiseRefs),
        kind: 'noise-mask',
        layers: [],
        maskLayers: noiseRefs,
      });
    }
  }

  return { bbox, entries };
};

/** The native (unscaled) content rect of a control layer's source (layer-local). */
const controlContentRect = (
  layer: CanvasControlLayerContract,
  doc: CanvasDocumentContractV3
): { width: number; height: number; x: number; y: number } => {
  const { source } = layer;
  if (source.type === 'image') {
    return { height: source.image.height, width: source.image.width, x: 0, y: 0 };
  }
  if (source.type === 'paint' && source.bitmap) {
    const offset = source.offset ?? { x: 0, y: 0 };
    return { height: source.bitmap.height, width: source.bitmap.width, x: offset.x, y: offset.y };
  }
  return { height: doc.height, width: doc.width, x: 0, y: 0 };
};

/**
 * Projects a control layer into a standalone composite contribution. Opacity is
 * forced to 1 and blend mode to `normal` (the layer's DISPLAY opacity/blend and
 * transparency effect never alter the control image sent to the backend — legacy
 * rasterizes control at opacity 1, no filters), so display tweaks don't churn the
 * entry key.
 */
const toControlLayerRef = (layer: CanvasControlLayerContract, doc: CanvasDocumentContractV3): CompositeLayerRef => {
  const rect = controlContentRect(layer, doc);
  return {
    blendMode: 'normal',
    contentOffset: { x: rect.x, y: rect.y },
    contentSize: { height: rect.height, width: rect.width },
    id: layer.id,
    opacity: 1,
    sourceRef: sourceRefOf(layer.source),
    transform: {
      rotation: layer.transform.rotation,
      scaleX: layer.transform.scaleX,
      scaleY: layer.transform.scaleY,
      x: layer.transform.x,
      y: layer.transform.y,
    },
  };
};

/** One control layer's separate composite (never blended with other control layers). */
export interface ControlCompositeEntry {
  layerId: string;
  entry: CompositeEntry;
}

/**
 * Plans one composite per enabled control layer WITH content — each composited
 * separately over `bbox` (legacy parity: control images are never blended
 * together). Empty control layers (no source / blank paint) are excluded (they
 * carry no control content and are rejected upstream with a "no control" reason).
 * Control layers never contribute to the `base-raster` composite, so they never
 * paint into the img2img/inpaint source.
 */
export const planControlComposites = (document: CanvasDocumentContractV3, bbox: Rect): ControlCompositeEntry[] =>
  contributingLayers(document, isControlLayerWithContent).map((layer) => {
    const ref = toControlLayerRef(layer, document);
    return {
      entry: {
        bbox,
        key: `control-layer|${layer.id}|${rectKey(bbox)}|${layerKey(ref)}`,
        kind: 'control-layer',
        layerId: layer.id,
        layers: [ref],
      },
      layerId: layer.id,
    };
  });

/** The native content rect of a regional mask's persisted bitmap (layer-local, at its offset). */
const regionalMaskContentRect = (
  layer: CanvasRegionalGuidanceLayerContract
): { width: number; height: number; x: number; y: number } => {
  const { bitmap, offset } = layer.mask;
  if (bitmap) {
    const o = offset ?? { x: 0, y: 0 };
    return { height: bitmap.height, width: bitmap.width, x: o.x, y: o.y };
  }
  return { height: 0, width: 0, x: 0, y: 0 };
};

/**
 * Projects a regional-guidance layer into a standalone ALPHA composite
 * contribution (opacity 1, normal blend) — the executor composites the mask's
 * alpha coverage over the bbox and uploads it, so `alpha_mask_to_tensor` can read
 * the region's alpha. Display opacity/blend never alter the mask sent to the
 * backend (mirrors control layers).
 */
const toRegionalMaskRef = (layer: CanvasRegionalGuidanceLayerContract): CompositeLayerRef => {
  const rect = regionalMaskContentRect(layer);
  return {
    blendMode: 'normal',
    contentOffset: { x: rect.x, y: rect.y },
    contentSize: { height: rect.height, width: rect.width },
    id: layer.id,
    opacity: 1,
    sourceRef: layer.mask.bitmap ? `mask:${layer.mask.bitmap.imageName}` : 'mask:empty',
    transform: {
      rotation: layer.transform.rotation,
      scaleX: layer.transform.scaleX,
      scaleY: layer.transform.scaleY,
      x: layer.transform.x,
      y: layer.transform.y,
    },
  };
};

/** One regional-guidance region's separate alpha-mask composite. */
export interface RegionalMaskCompositeEntry {
  layerId: string;
  entry: CompositeEntry;
}

/**
 * Plans one alpha-mask composite per enabled regional-guidance layer WITH mask
 * content — each composited separately over `bbox` (a region's mask feeds its own
 * `alpha_mask_to_tensor`; regions are never combined). Regions without mask
 * content carry no region and are skipped (they'd be rejected upstream with a
 * "no region" reason). Regional layers never contribute to `base-raster`.
 */
export const planRegionalMaskComposites = (
  document: CanvasDocumentContractV3,
  bbox: Rect
): RegionalMaskCompositeEntry[] =>
  contributingLayers(document, isRegionalGuidanceWithMask).map((layer) => {
    const ref = toRegionalMaskRef(layer);
    return {
      entry: {
        bbox,
        key: `regional-mask|${layer.id}|${rectKey(bbox)}|${layerKey(ref)}`,
        kind: 'regional-mask',
        layerId: layer.id,
        layers: [ref],
      },
      layerId: layer.id,
    };
  });
