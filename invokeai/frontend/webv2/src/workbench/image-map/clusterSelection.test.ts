import { describe, expect, it } from 'vitest';

import type { ImageMapPoint } from './api';

import { collectClusterSelection } from './clusterSelection';
import {
  buildClusterAnnotations,
  buildHighlightedPointsTrace,
  declutterAnnotations,
  HIGHLIGHTED_POINTS_TRACE,
} from './imageMapTraces';

const point = (imageName: string, x: number, y: number, cluster: number): ImageMapPoint => ({
  cluster,
  imageName,
  x,
  y,
});

const POINTS = [
  point('a.png', 0, 0, 0),
  point('b.png', 3, 0, 0),
  point('c.png', 1, 0, 0),
  point('other.png', 50, 50, 1),
  point('noise.png', -50, 50, -1),
];

describe('collectClusterSelection', () => {
  it('returns the clicked cluster ordered by distance from the click', () => {
    expect(collectClusterSelection(POINTS, 'b.png')).toEqual(['b.png', 'c.png', 'a.png']);
  });

  it('returns null for noise points and unknown names', () => {
    expect(collectClusterSelection(POINTS, 'noise.png')).toBeNull();
    expect(collectClusterSelection(POINTS, 'missing.png')).toBeNull();
  });

  it('caps oversized clusters, keeping the nearest members', () => {
    const capped = collectClusterSelection(POINTS, 'a.png', 2);
    expect(capped).toEqual(['a.png', 'c.png']);
  });
});

describe('buildHighlightedPointsTrace', () => {
  it('draws only multi-selections, larger and outlined', () => {
    const single = buildHighlightedPointsTrace(POINTS, new Set(['a.png']));
    expect(single.x).toEqual([]);

    const multi = buildHighlightedPointsTrace(POINTS, new Set(['a.png', 'c.png']));
    expect(multi.name).toBe(HIGHLIGHTED_POINTS_TRACE);
    expect(multi.customdata).toEqual(['a.png', 'c.png']);
    expect(multi.marker.size).toBe(8);
    expect(multi.marker.line).toEqual({ color: '#FFFFFF', width: 1 });
  });
});

describe('buildClusterAnnotations', () => {
  it('places one annotation per labeled cluster, centered above its topmost point', () => {
    const varied = [point('a.png', 0, 1, 0), point('b.png', 3, 5, 0), point('c.png', 1, 3, 0)];
    const annotations = buildClusterAnnotations(varied, { '0': 'landscapes' });

    expect(annotations).toHaveLength(1);
    const landscapes = annotations[0];
    // Centered on the cluster's x centroid, anchored above its topmost point
    // with a pixel lift so the label never covers the points it names.
    expect(landscapes?.x).toBeCloseTo(4 / 3);
    expect(landscapes?.y).toBeCloseTo(5);
    expect(landscapes?.yanchor).toBe('bottom');
    expect(landscapes?.yshift).toBeGreaterThan(0);
    // Readable on any theme: white text on a dark pill.
    expect(landscapes?.font.color).toBe('#FFFFFF');
  });

  it('skips noise, unlabeled clusters, and null label maps', () => {
    expect(buildClusterAnnotations(POINTS, null)).toEqual([]);
    const onlyOne = buildClusterAnnotations(POINTS, { '1': 'portraits' });
    expect(onlyOne.map((annotation) => annotation.text)).toEqual(['portraits']);
  });

  it('orders annotations by cluster size so declutter keeps the biggest labels', () => {
    // The smaller cluster's point comes FIRST in the points array: without the
    // explicit sort, Map insertion order would put 'portraits' first.
    const smallFirst = [point('solo.png', 10, 0, 1), point('a.png', 0, 0, 0), point('b.png', 1, 0, 0)];
    const annotations = buildClusterAnnotations(smallFirst, { '0': 'landscapes', '1': 'portraits' });
    expect(annotations.map((annotation) => annotation.text)).toEqual(['landscapes', 'portraits']);
  });

  it('breaks size ties by cluster id, ascending', () => {
    const tied = [point('b.png', 10, 0, 1), point('a.png', 0, 0, 0)];
    const annotations = buildClusterAnnotations(tied, { '0': 'landscapes', '1': 'portraits' });
    expect(annotations.map((annotation) => annotation.text)).toEqual(['landscapes', 'portraits']);
  });
});

describe('declutterAnnotations', () => {
  // Cluster 0: three points near the origin; cluster 1: one point at (10, 0).
  // The small cluster's point deliberately comes first, so these tests fail
  // if the size-priority ordering in buildClusterAnnotations regresses.
  const clusters = [
    point('far.png', 10, 0, 1),
    point('a.png', 0, 0, 0),
    point('b.png', 1, 0, 0),
    point('c.png', 2, 0, 0),
  ];
  const annotations = buildClusterAnnotations(clusters, { '0': 'landscapes', '1': 'portraits' });
  const view = { widthPx: 800, heightPx: 600 };

  it('keeps every label when the view gives them room', () => {
    // Zoomed in: 11 data units across 800px puts the anchors ~650px apart.
    const ranges = { x: [-0.5, 10.5] as [number, number], y: [-4, 4] as [number, number] };
    const kept = declutterAnnotations(annotations, ranges, view.widthPx, view.heightPx);
    expect(kept.map((annotation) => annotation.text)).toEqual(['landscapes', 'portraits']);
  });

  it('drops the smaller cluster label when zooming out collapses the gap', () => {
    // Zoomed way out: 1000 data units across 800px squeezes the anchors to
    // ~7px apart — well inside either label's pixel footprint.
    const ranges = { x: [-500, 500] as [number, number], y: [-375, 375] as [number, number] };
    const kept = declutterAnnotations(annotations, ranges, view.widthPx, view.heightPx);
    expect(kept.map((annotation) => annotation.text)).toEqual(['landscapes']);
  });

  it('keeps labels that overlap horizontally but are far apart vertically', () => {
    // Both clusters share x≈0 but sit 2 data units apart in y; at 75px per
    // unit that is 150px of vertical separation — no collision, both kept.
    // Collapsing the y term in the collision math would fail this.
    const stacked = [point('top.png', 0, 2, 1), point('a.png', 0, 0, 0), point('b.png', 1, 0, 0)];
    const stackedAnnotations = buildClusterAnnotations(stacked, { '0': 'landscapes', '1': 'portraits' });
    const ranges = { x: [-4, 4] as [number, number], y: [-3, 5] as [number, number] };
    const kept = declutterAnnotations(stackedAnnotations, ranges, 800, 600);
    expect(kept.map((annotation) => annotation.text)).toEqual(['landscapes', 'portraits']);
  });

  it('drops labels covering the current-image marker, which draws beneath them', () => {
    // Zoomed in, both labels normally survive (see the first case). Putting the
    // marker on the 'portraits' anchor at (10, 0) evicts that label instead:
    // the gold target is on the WebGL canvas under plotly's annotation layer,
    // so it cannot be stacked over a pill it overlaps.
    const ranges = { x: [-0.5, 10.5] as [number, number], y: [-4, 4] as [number, number] };
    const kept = declutterAnnotations(annotations, ranges, view.widthPx, view.heightPx, { x: 10, y: 0 });
    expect(kept.map((annotation) => annotation.text)).toEqual(['landscapes']);
  });

  it('ignores a marker that is nowhere near a label', () => {
    const ranges = { x: [-0.5, 10.5] as [number, number], y: [-4, 4] as [number, number] };
    const kept = declutterAnnotations(annotations, ranges, view.widthPx, view.heightPx, { x: 5, y: -3.5 });
    expect(kept.map((annotation) => annotation.text)).toEqual(['landscapes', 'portraits']);
    // A null marker (nothing selected, or the selection is off the map) is the
    // same as passing none at all.
    expect(declutterAnnotations(annotations, ranges, view.widthPx, view.heightPx, null)).toEqual(
      declutterAnnotations(annotations, ranges, view.widthPx, view.heightPx)
    );
  });

  it('does not hand the space it clears to a lower-priority label', () => {
    // 'portraits' (1 point) anchors ~55px from 'landscapes' (3 points): inside
    // the bigger label's footprint, outside the marker's clearance. Without the
    // marker, 'landscapes' wins the spot and 'portraits' is dropped. Parking
    // the marker on 'landscapes' must not promote 'portraits' into the very
    // patch of map the marker was supposed to clear.
    const crowded = [
      point('a.png', 0, 0, 0),
      point('b.png', 1, 0, 0),
      point('c.png', 0.5, 0, 0),
      point('solo.png', 1.256, 0, 1),
    ];
    const crowdedAnnotations = buildClusterAnnotations(crowded, { '0': 'landscapes', '1': 'portraits' });
    const ranges = { x: [-0.5, 10.5] as [number, number], y: [-4, 4] as [number, number] };

    expect(
      declutterAnnotations(crowdedAnnotations, ranges, view.widthPx, view.heightPx).map((annotation) => annotation.text)
    ).toEqual(['landscapes']);
    expect(
      declutterAnnotations(crowdedAnnotations, ranges, view.widthPx, view.heightPx, { x: 0.5, y: 0 }).map(
        (annotation) => annotation.text
      )
    ).toEqual([]);
  });

  it('leaves labels the marker does not cover exactly as they were', () => {
    // Three labels 50px apart: 'bbb' loses its spot to 'aaa' and is invisible
    // with or without a marker, while 'ccc' clears 'aaa' and survives. Parking
    // the marker on 'bbb' — whose 11px rect reaches neither neighbour — must
    // change nothing: a label that never won a spot cannot reserve one, or
    // selecting an image under an already-suppressed label would silently take
    // out the cluster next door.
    const row = [
      point('a1.png', 0, 0, 0),
      point('a2.png', 0, 0, 0),
      point('a3.png', 0, 0, 0),
      point('b1.png', 0.6875, 0, 1),
      point('b2.png', 0.6875, 0, 1),
      point('c1.png', 1.375, 0, 2),
    ];
    const rowAnnotations = buildClusterAnnotations(row, { '0': 'aaaaaaaaaa', '1': 'bbbbbbbbbb', '2': 'cccccccccc' });
    const ranges = { x: [-0.5, 10.5] as [number, number], y: [-4, 4] as [number, number] };
    const withoutMarker = declutterAnnotations(rowAnnotations, ranges, view.widthPx, view.heightPx);

    expect(withoutMarker.map((annotation) => annotation.text)).toEqual(['aaaaaaaaaa', 'cccccccccc']);
    expect(declutterAnnotations(rowAnnotations, ranges, view.widthPx, view.heightPx, { x: 0.6875, y: 0 })).toEqual(
      withoutMarker
    );
  });

  it('ignores a marker panned out of view', () => {
    // Nothing off screen can be covered, so an off-view marker must not evict
    // an off-view label — that would churn the applied set on every pan.
    const offscreen = [point('a.png', -900, 0, 0), point('b.png', -900.1, 0, 0)];
    const offscreenAnnotations = buildClusterAnnotations(offscreen, { '0': 'landscapes' });
    const ranges = { x: [100, 200] as [number, number], y: [-50, 50] as [number, number] };

    expect(
      declutterAnnotations(offscreenAnnotations, ranges, view.widthPx, view.heightPx, { x: -900, y: 0 }).map(
        (annotation) => annotation.text
      )
    ).toEqual(['landscapes']);
  });

  it('treats a marker with non-finite coordinates as absent', () => {
    const ranges = { x: [-0.5, 10.5] as [number, number], y: [-4, 4] as [number, number] };
    expect(
      declutterAnnotations(annotations, ranges, view.widthPx, view.heightPx, { x: Number.NaN, y: 0 }).map(
        (annotation) => annotation.text
      )
    ).toEqual(['landscapes', 'portraits']);
  });

  it('returns the full set unfiltered when the viewport is degenerate', () => {
    const ranges = { x: [0, 0] as [number, number], y: [-375, 375] as [number, number] };
    expect(declutterAnnotations(annotations, ranges, view.widthPx, view.heightPx)).toEqual(annotations);
    const sane = { x: [-500, 500] as [number, number], y: [-375, 375] as [number, number] };
    expect(declutterAnnotations(annotations, sane, 0, view.heightPx)).toEqual(annotations);
  });
});
