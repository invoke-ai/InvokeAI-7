import type { GalleryItemKey } from '@features/gallery/contracts';
import type { Layout } from 'plotly.js';

import type { ImageMapPoint } from './api';
import type { AxisRanges } from './imageMapViewport';

import { getClusterColor } from './clusterPalette';

/**
 * Pure WebGL-independent trace builders follow PhotoMapAI's fixed named order, placing Current Image last so gold
 * markers render above other traces.
 */

export const ALL_POINTS_TRACE = 'All Points';
export const HIGHLIGHTED_POINTS_TRACE = 'Highlighted Points';
export const CURRENT_IMAGE_TRACE = 'Current Image';

/** Opacity for DBSCAN noise points (cluster -1); clustered points are solid. */
const NOISE_OPACITY = 0.25;
const POINT_OPACITY = 0.85;

export interface ScatterTrace {
  x: number[];
  y: number[];
  customdata: string[];
  mode: 'markers';
  type: 'scattergl';
  name: string;
  hoverinfo: 'none' | 'skip' | 'text';
  text?: string[];
  marker: {
    color: string | string[];
    opacity: number | number[];
    size: number;
    symbol?: string | string[];
    line?: { color: string; width: number };
  };
}

/** Marker shapes per media kind; see `buildAllPointsTrace`. */
const IMAGE_SYMBOL = 'circle';
const VIDEO_SYMBOL = 'diamond';

export const buildAllPointsTrace = (points: ImageMapPoint[]): ScatterTrace => ({
  // The gallery's item key, so a click or hover resolves back to the kind the
  // point stands for — plotly carries strings, and a bare name would not say
  // whether it names an image or a video.
  customdata: points.map((point) => point.key),
  hoverinfo: 'none',
  marker: {
    color: points.map((point) => getClusterColor(point.cluster)),
    opacity: points.map((point) => (point.cluster < 0 ? NOISE_OPACITY : POINT_OPACITY)),
    size: 5,
    // Diamonds identify videos independently of cluster color without requiring hover.
    symbol: points.map((point) => (point.item.kind === 'video' ? VIDEO_SYMBOL : IMAGE_SYMBOL)),
  },
  mode: 'markers',
  name: ALL_POINTS_TRACE,
  type: 'scattergl',
  x: points.map((point) => point.x),
  y: points.map((point) => point.y),
});

/** White-outlined enlarged multi-selection trace; fewer than two items need only the gold current target. */
export const buildHighlightedPointsTrace = (
  points: ImageMapPoint[],
  selectedKeys: ReadonlySet<GalleryItemKey>
): ScatterTrace => {
  const selected = selectedKeys.size >= 2 ? points.filter((point) => selectedKeys.has(point.key)) : [];

  return {
    customdata: selected.map((point) => point.key),
    // 'skip': highlighted points sit over their base points, which carry the
    // same customdata — hit-testing should fall through to them.
    hoverinfo: 'skip',
    marker: {
      color: selected.map((point) => getClusterColor(point.cluster)),
      line: { color: '#FFFFFF', width: 1 },
      opacity: 1,
      // The overlay sits on top of the base point, so it carries the kind's
      // shape too — otherwise selecting a video turns its diamond into a circle.
      symbol: selected.map((point) => (point.item.kind === 'video' ? VIDEO_SYMBOL : IMAGE_SYMBOL)),
      size: 8,
    },
    mode: 'markers',
    name: HIGHLIGHTED_POINTS_TRACE,
    type: 'scattergl',
    x: selected.map((point) => point.x),
    y: selected.map((point) => point.y),
  };
};

/** Gold current-item target, populated by live selection restyles. */
export const buildCurrentImageTrace = (): ScatterTrace => ({
  customdata: [],
  // 'skip' (not 'none') excludes the marker from hit-testing entirely, so
  // clicks and hovers land on the underlying data point it covers.
  hoverinfo: 'skip',
  marker: {
    color: '#FFD700',
    line: { color: '#000000', width: 2 },
    opacity: 1,
    size: 18,
    symbol: 'circle-dot',
  },
  mode: 'markers',
  name: CURRENT_IMAGE_TRACE,
  type: 'scattergl',
  x: [],
  y: [],
});

// Theme-independent grid with a stronger origin for orientation.
const GRID_LINE_COLOR = 'rgba(128, 128, 128, 0.16)';
const GRID_ZERO_COLOR = 'rgba(128, 128, 128, 0.32)';

/**
 * Restyle every per-point array derived from the trace. Plotly retains omitted arrays, causing scattergl length
 * mismatches after selection changes.
 */
export const toHighlightRestyle = (trace: ScatterTrace): Record<string, unknown[]> => ({
  customdata: [trace.customdata],
  'marker.color': [trace.marker.color as string[]],
  'marker.symbol': [trace.marker.symbol as string[]],
  x: [trace.x],
  y: [trace.y],
});

export const buildMapLayout = (
  initialRanges?: AxisRanges | null,
  annotations: ClusterAnnotation[] = []
): Partial<Layout> => ({
  annotations: annotations as unknown as Layout['annotations'],
  dragmode: 'pan',
  margin: { b: 0, l: 0, r: 0, t: 0 },
  paper_bgcolor: 'rgba(0,0,0,0)',
  plot_bgcolor: 'rgba(0,0,0,0)',
  showlegend: false,
  // Preserves the user's pan/zoom across Plotly.react data updates.
  uirevision: 'image-map',
  xaxis: {
    gridcolor: GRID_LINE_COLOR,
    gridwidth: 1,
    range: initialRanges?.x,
    scaleanchor: 'y',
    showgrid: true,
    showticklabels: false,
    zeroline: true,
    zerolinecolor: GRID_ZERO_COLOR,
    zerolinewidth: 1,
  },
  yaxis: {
    gridcolor: GRID_LINE_COLOR,
    gridwidth: 1,
    range: initialRanges?.y,
    showgrid: true,
    showticklabels: false,
    zeroline: true,
    zerolinecolor: GRID_ZERO_COLOR,
    zerolinewidth: 1,
  },
});

export interface ClusterAnnotation {
  x: number;
  y: number;
  text: string;
  showarrow: false;
  font: { color: string; size: number };
  bgcolor: string;
  borderpad: number;
  opacity: number;
  xanchor: 'center';
  yanchor: 'bottom';
  yshift: number;
}

/**
 * Place theme-independent cluster pills above topmost points with fixed-pixel clearance. Sort largest clusters
 * first, then id, defining declutter priority.
 */
export const buildClusterAnnotations = (
  points: ImageMapPoint[],
  labelsByCluster: Record<string, string> | null
): ClusterAnnotation[] => {
  if (!labelsByCluster) {
    return [];
  }

  const sums = new Map<number, { count: number; x: number; maxY: number }>();

  for (const point of points) {
    if (point.cluster < 0 || !(String(point.cluster) in labelsByCluster)) {
      continue;
    }

    const entry = sums.get(point.cluster) ?? { count: 0, maxY: -Infinity, x: 0 };
    entry.count += 1;
    entry.x += point.x;
    entry.maxY = Math.max(entry.maxY, point.y);
    sums.set(point.cluster, entry);
  }

  return [...sums.entries()]
    .sort(([clusterA, a], [clusterB, b]) => b.count - a.count || clusterA - clusterB)
    .map(([cluster, { count, x, maxY }]) => ({
      bgcolor: 'rgba(0,0,0,0.65)',
      borderpad: 2,
      font: { color: '#FFFFFF', size: 10 },
      opacity: 1,
      showarrow: false,
      text: labelsByCluster[String(cluster)],
      x: x / count,
      xanchor: 'center',
      y: maxY,
      yanchor: 'bottom',
      yshift: 8,
    }));
};

// Estimate SVG label collision width from fixed-10px text length because labels cannot be measured before drawing.
const LABEL_CHAR_WIDTH_PX = 6;
const LABEL_HEIGHT_PX = 18;
/** Two labels closer than this (edge to edge) count as colliding. */
const LABEL_GAP_PX = 4;
/** Marker half-extent includes its 18px size, 2px outline and one extra pixel of label clearance. */
const MARKER_RADIUS_PX = 11;

interface LabelRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

const rectsCollide = (a: LabelRect, b: LabelRect): boolean =>
  a.left < b.right + LABEL_GAP_PX &&
  a.right > b.left - LABEL_GAP_PX &&
  a.top < b.bottom + LABEL_GAP_PX &&
  a.bottom > b.top - LABEL_GAP_PX;

/**
 * Return onscreen marker footprint only; offscreen reservations churn invisible labels during panning. Bounds
 * checks reject NaN too.
 */
const markerRectFor = (
  markerPoint: { x: number; y: number },
  ranges: AxisRanges,
  spanX: number,
  spanY: number,
  widthPx: number,
  heightPx: number
): LabelRect | null => {
  const centerX = ((markerPoint.x - ranges.x[0]) / spanX) * widthPx;
  const centerY = ((ranges.y[1] - markerPoint.y) / spanY) * heightPx;
  const onScreen =
    centerX >= -MARKER_RADIUS_PX &&
    centerX <= widthPx + MARKER_RADIUS_PX &&
    centerY >= -MARKER_RADIUS_PX &&
    centerY <= heightPx + MARKER_RADIUS_PX;

  return onScreen
    ? {
        bottom: centerY + MARKER_RADIUS_PX,
        left: centerX - MARKER_RADIUS_PX,
        right: centerX + MARKER_RADIUS_PX,
        top: centerY - MARKER_RADIUS_PX,
      }
    : null;
};

/**
 * Greedily retain noncolliding labels in priority order. Current-image markers outrank labels because Plotly SVG
 * annotations render above WebGL and cannot be stacked underneath the gold target.
 */
export const declutterAnnotations = (
  annotations: ClusterAnnotation[],
  ranges: AxisRanges,
  widthPx: number,
  heightPx: number,
  markerPoint?: { x: number; y: number } | null
): ClusterAnnotation[] => {
  const spanX = ranges.x[1] - ranges.x[0];
  const spanY = ranges.y[1] - ranges.y[0];

  if (spanX <= 0 || spanY <= 0 || widthPx <= 0 || heightPx <= 0) {
    return annotations;
  }

  const kept: ClusterAnnotation[] = [];
  // Footprints later labels must avoid: every label that won its spot,
  // including the ones the marker then hid (see below).
  const blockingRects: LabelRect[] = [];
  const markerRect = markerPoint ? markerRectFor(markerPoint, ranges, spanX, spanY, widthPx, heightPx) : null;

  for (const annotation of annotations) {
    const centerX = ((annotation.x - ranges.x[0]) / spanX) * widthPx;
    // Screen y grows downward; yanchor 'bottom' + positive yshift puts the
    // pill's bottom edge yshift pixels above the anchor point.
    const bottom = ((ranges.y[1] - annotation.y) / spanY) * heightPx - annotation.yshift;
    const halfWidth = (annotation.text.length * LABEL_CHAR_WIDTH_PX) / 2 + annotation.borderpad;
    const rect: LabelRect = {
      bottom,
      left: centerX - halfWidth,
      right: centerX + halfWidth,
      top: bottom - LABEL_HEIGHT_PX,
    };

    if (blockingRects.some((other) => rectsCollide(rect, other))) {
      continue;
    }

    // Reserve a winning label's space before testing marker overlap, preventing lower-priority replacements in the
    // cleared region. Labels already losing to another label reserve nothing.
    blockingRects.push(rect);

    if (markerRect !== null && rectsCollide(rect, markerRect)) {
      continue;
    }

    kept.push(annotation);
  }

  return kept;
};
