/**
 * Identity of a semantic gallery search: a text prompt, a gallery image, a
 * web image URL, a dropped file held in the external-image registry, or an
 * image-map cluster held in the cluster registry.
 */
export type GallerySemanticQuery =
  | { kind: 'text'; query: string }
  | { kind: 'image'; imageName: string }
  | { kind: 'url'; url: string }
  | { kind: 'file'; fileId: string }
  | { kind: 'cluster'; clusterId: string };

/**
 * A persisted semantic search: a text prompt, a gallery image, a web URL, a
 * dropped file, or an image-map cluster.
 */
export type GallerySemanticReference =
  | { kind: 'text'; query: string }
  | { kind: 'image'; imageName: string }
  | { kind: 'url'; url: string }
  | { kind: 'file'; fileId: string; label: string }
  | { kind: 'cluster'; clusterId: string; label: string };

/**
 * Stable identity for equality checks and fetch keys. A file reference is
 * identified by its registry key alone — the label is presentation, not
 * identity, so relabeling must not read as a different query.
 */
export const gallerySemanticReferenceKey = (reference: GallerySemanticReference | null): string => {
  if (reference === null) {
    return '';
  }

  switch (reference.kind) {
    case 'text':
      return `text:${reference.query}`;
    case 'image':
      return `image:${reference.imageName}`;
    case 'url':
      return `url:${reference.url}`;
    case 'file':
      return `file:${reference.fileId}`;
    case 'cluster':
      return `cluster:${reference.clusterId}`;
  }
};

/** The label-free shape a reference contributes to query cache keys. */
export const toGallerySemanticQuery = (reference: GallerySemanticReference): GallerySemanticQuery => {
  switch (reference.kind) {
    case 'text':
      return { kind: 'text', query: reference.query };
    case 'image':
      return { imageName: reference.imageName, kind: 'image' };
    case 'url':
      return { kind: 'url', url: reference.url };
    case 'file':
      return { fileId: reference.fileId, kind: 'file' };
    case 'cluster':
      return { clusterId: reference.clusterId, kind: 'cluster' };
  }
};

/*
 * In-memory registry for externally dropped reference images (OS file drops).
 * Blobs cannot live in persisted widget values, so the persisted value keeps a
 * registry key; a key that no longer resolves (e.g. after a reload) reads as a
 * cleared search. Only one external query is active at a time, so registering
 * a new file evicts the previous one.
 */

let nextId = 0;

const files = new Map<string, { blob: Blob; label: string }>();

export const registerExternalImageFile = (blob: Blob, label: string): string => {
  nextId += 1;
  // The counter alone is only unique per JS realm, while the id is persisted
  // in widget values; the random token keeps ids from two realms (another
  // tab, a reload) from colliding into the wrong blob.
  const fileId = `external-${String(nextId)}-${Math.random().toString(36).slice(2, 10)}`;

  files.clear();
  files.set(fileId, { blob, label });

  return fileId;
};

export const getExternalImageFile = (fileId: string): { blob: Blob; label: string } | null => files.get(fileId) ?? null;

/*
 * In-memory registry for image-map cluster queries, mirroring the file
 * registry above: a cluster's member list (which can run to thousands of
 * names) cannot live in persisted widget values, so the persisted value keeps
 * a registry key, and a key that no longer resolves (e.g. after a reload)
 * reads as a cleared search. Only one cluster query is active at a time, so
 * registering a new cluster evicts the previous one.
 */

let nextClusterId = 0;

const clusters = new Map<string, { imageNames: string[]; label: string }>();

export const registerImageCluster = (imageNames: string[], label: string): string => {
  nextClusterId += 1;
  // Same shape as file ids: the random token keeps a persisted id from a
  // previous JS realm (another tab, a reload) from resolving to this realm's
  // unrelated cluster.
  const clusterId = `cluster-${String(nextClusterId)}-${Math.random().toString(36).slice(2, 10)}`;

  clusters.clear();
  clusters.set(clusterId, { imageNames, label });

  return clusterId;
};

export const getImageCluster = (clusterId: string): { imageNames: string[]; label: string } | null =>
  clusters.get(clusterId) ?? null;

/**
 * Drops deleted images from the registered cluster, in step with the gallery's
 * optimistic cache patch: the member list is client-owned, so without this the
 * cluster view's total (and its trailing page) would keep counting images that
 * no longer exist. Returns a rollback that puts back exactly the names THIS
 * call removed — a no-op once a different registration owns the slot.
 */
export const pruneImageClusterMembers = (imageNames: readonly string[]): (() => void) => {
  const entry = [...clusters.entries()].at(0);

  if (!entry || imageNames.length === 0) {
    return () => undefined;
  }

  const [clusterId, cluster] = entry;
  const requested = new Set(imageNames);
  const originalNames = cluster.imageNames;
  const removedNames = originalNames.filter((name) => requested.has(name));

  if (removedNames.length === 0) {
    return () => undefined;
  }

  const removed = new Set(removedNames);

  clusters.set(clusterId, {
    imageNames: originalNames.filter((name) => !removed.has(name)),
    label: cluster.label,
  });

  return () => {
    const current = clusters.get(clusterId);

    if (!current) {
      return;
    }

    // Rebuilt from the pre-prune order rather than swapped back wholesale, so
    // that a concurrent deletion's prune (or its rollback) landing in between
    // survives: whatever this call did not remove keeps whatever state the
    // other call left it in. Restoring the captured array instead would either
    // resurrect that deletion's images or — guarded on identity — skip the
    // restore entirely and strand a failed deletion's image outside the list.
    const restored = new Set([...current.imageNames, ...removedNames]);

    clusters.set(clusterId, {
      imageNames: originalNames.filter((name) => restored.has(name)),
      label: current.label,
    });
  };
};

/**
 * Parses a persisted widget value into a semantic reference. Tolerates the
 * legacy bare-image-name shape, and reads a file key that no longer resolves
 * in the registry as no search at all.
 */
/**
 * A reference that only this session can resolve — a dropped file or an
 * image-map cluster.
 *
 * Both kinds name an entry in an in-memory registry, and their ids carry a
 * per-realm token, so a persisted one can never resolve again: a reload, or a
 * second tab, reads it as no search at all. Anything set against the ranking
 * it named — the page the footer was on, above all — describes a list that
 * will not exist there either.
 */
const isSessionScopedGallerySemanticReference = (value: unknown): boolean =>
  !!value &&
  typeof value === 'object' &&
  ((value as Record<string, unknown>).kind === 'file' || (value as Record<string, unknown>).kind === 'cluster');

/**
 * The same values with every position that was set against a ranking the
 * caller's test rejects, or null when there is nothing to drop.
 *
 * While a similarity search is on screen the footer paginates the RANKING, so
 * the gallery's page and the page stamped on the selection are both indexes
 * into it. Left behind by a search that is gone, they are read as board pages
 * and answer with an unrelated slice. Only keys that are actually carrying a
 * position are rewritten: normalizing must not mint state that was never
 * stored.
 *
 * The test differs by caller, and the difference matters. See
 * `stripSessionScopedGallerySearch` and `stripUnresolvableGallerySearch`.
 */
const stripGallerySearchPositions = (
  values: Record<string, unknown>,
  shouldStrip: (value: unknown) => boolean
): Record<string, unknown> | null => {
  if (!shouldStrip(values.semanticImageQuery)) {
    return null;
  }

  const nextValues: Record<string, unknown> = { ...values, semanticImageQuery: null };

  if (typeof values.galleryPage === 'number' && values.galleryPage !== 0) {
    nextValues.galleryPage = 0;
  }

  if (typeof values.selectedImagePage === 'number' && values.selectedImagePage !== 0) {
    nextValues.selectedImagePage = 0;
  }

  const selectedImageQuery =
    values.selectedImageQuery && typeof values.selectedImageQuery === 'object'
      ? (values.selectedImageQuery as Record<string, unknown>)
      : null;

  if (selectedImageQuery && typeof selectedImageQuery.page === 'number' && selectedImageQuery.page !== 0) {
    nextValues.selectedImageQuery = { ...selectedImageQuery, page: 0 };
  }

  return nextValues;
};

/**
 * The same values with an infinite window's mid-board anchor dropped, or null
 * when there is none.
 *
 * In infinite mode `galleryPage` is not a page number but the anchor of a
 * mid-board window, set by a reveal from the image map. That is a "you are
 * here" for the session that made it: restored anywhere else it opens the
 * gallery stranded in the middle of a board, with no page control (the
 * footer's is paginated-only) and no way back to the top short of switching
 * boards. Paginated pages stay — there the value really is the page the user
 * was reading.
 */
export const stripInfiniteWindowAnchor = (values: Record<string, unknown>): Record<string, unknown> | null =>
  values.paginationMode !== 'paginated' && typeof values.galleryPage === 'number' && values.galleryPage > 0
    ? { ...values, galleryPage: 0 }
    : null;

/**
 * For the SAVE path: drop what the realm reading this back will not have.
 *
 * A dropped file or an image-map cluster names an entry in an in-memory
 * registry, and its id carries a per-realm token, so it resolves here and
 * nowhere else — the test has to be what the value IS, not whether it works
 * right now, because right now it does.
 */
export const stripSessionScopedGallerySearch = (values: Record<string, unknown>): Record<string, unknown> | null =>
  stripGallerySearchPositions(
    values,
    (value) =>
      isSessionScopedGallerySemanticReference(value) ||
      (value !== null && value !== undefined && parseGallerySemanticReference(value) === null)
  );

/**
 * For the ADOPTION path: drop only what this realm cannot resolve.
 *
 * `normalizeWorkbenchProject` runs on projects that never left — closing and
 * reopening one, a conflict fork rescuing the live copy, an export re-imported
 * into the same session. There the registry entry is still live and the
 * ranking is still on screen, so asking what the value IS would delete the
 * search the user is looking at. Asking whether it resolves HERE answers both
 * cases with one test.
 */
export const stripUnresolvableGallerySearch = (values: Record<string, unknown>): Record<string, unknown> | null =>
  stripGallerySearchPositions(
    values,
    (value) => value !== null && value !== undefined && parseGallerySemanticReference(value) === null
  );

export const parseGallerySemanticReference = (value: unknown): GallerySemanticReference | null => {
  // Legacy shape: a bare image name.
  if (typeof value === 'string' && value) {
    return { imageName: value, kind: 'image' };
  }

  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;

    if (record.kind === 'text' && typeof record.query === 'string' && record.query) {
      return { kind: 'text', query: record.query };
    }

    if (record.kind === 'image' && typeof record.imageName === 'string' && record.imageName) {
      return { imageName: record.imageName, kind: 'image' };
    }

    if (record.kind === 'url' && typeof record.url === 'string' && record.url) {
      return { kind: 'url', url: record.url };
    }

    if (record.kind === 'file' && typeof record.fileId === 'string' && record.fileId) {
      // Dropped files live in an in-memory registry; a persisted key that no
      // longer resolves (e.g. after a reload) reads as no search at all.
      if (getExternalImageFile(record.fileId) === null) {
        return null;
      }

      return {
        fileId: record.fileId,
        kind: 'file',
        label: typeof record.label === 'string' && record.label ? record.label : 'dropped image',
      };
    }

    if (record.kind === 'cluster' && typeof record.clusterId === 'string' && record.clusterId) {
      // Cluster members live in an in-memory registry; a persisted key that
      // no longer resolves (e.g. after a reload) reads as no search at all.
      const cluster = getImageCluster(record.clusterId);

      if (cluster === null) {
        return null;
      }

      return {
        clusterId: record.clusterId,
        kind: 'cluster',
        label: typeof record.label === 'string' && record.label ? record.label : cluster.label,
      };
    }
  }

  return null;
};

/** Matches this app's own image URLs so in-app drags become by-name queries. */
const APP_IMAGE_PATH = /\/api\/v\d+\/images\/i\/([^/]+)\//;

/**
 * Interpret a native drop for image-similarity search. Files win over URLs;
 * a URL pointing at this app's own image endpoint becomes a by-name query
 * (dragging the preview image in must not round-trip through the server's
 * URL downloader — it would be refused as a private-address fetch); anything
 * else http(s) is searched as a web image. Returns null for unusable drops.
 */
export const semanticReferenceFromDataTransfer = (dataTransfer: {
  files: ArrayLike<File>;
  getData: (format: string) => string;
}): GallerySemanticReference | null => {
  const file = Array.from(dataTransfer.files).find((candidate) => candidate.type.startsWith('image/'));

  if (file) {
    const label = file.name || 'dropped image';

    return { fileId: registerExternalImageFile(file, label), kind: 'file', label };
  }

  const uri = dataTransfer
    .getData('text/uri-list')
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith('#'));

  if (!uri || !/^https?:\/\//i.test(uri)) {
    return null;
  }

  const appImageMatch = APP_IMAGE_PATH.exec(uri);

  if (appImageMatch?.[1]) {
    try {
      return { imageName: decodeURIComponent(appImageMatch[1]), kind: 'image' };
    } catch {
      return null;
    }
  }

  return { kind: 'url', url: uri };
};
