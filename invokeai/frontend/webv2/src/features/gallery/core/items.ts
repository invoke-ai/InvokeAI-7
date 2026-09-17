import { normalizeServerTimestamp } from '@platform/time/serverTimestamp';

import type { GalleryImage, GalleryOrderDir, GeneratedImageContract } from './types';

export type GalleryItemKind = 'image' | 'video';

export type GalleryItemCategory = GalleryImage['imageCategory'];

export interface GalleryItemRef {
  kind: GalleryItemKind;
  name: string;
}

export type GalleryItemKey = `${GalleryItemKind}:${string}`;

interface GalleryItemBase {
  boardId: string;
  category: GalleryItemCategory;
  createdAt: string;
  fullUrl: string;
  height: number;
  isIntermediate: boolean;
  name: string;
  starred: boolean;
  thumbnailUrl: string;
  width: number;
}

export interface GalleryImageItem extends GalleryItemBase {
  kind: 'image';
  sourceQueueItemId?: string;
}

export interface GalleryVideoItem extends GalleryItemBase {
  durationSeconds: number;
  fps?: number;
  kind: 'video';
  /**
   * How the video entered the gallery, when the server marked it. `'audio_upload'` means an
   * uploaded audio file the ingest converter wrapped into a rendered-waveform video — its
   * frames are a picture of the sound, not footage.
   */
  mediaOrigin?: string;
}

export type GalleryItem = GalleryImageItem | GalleryVideoItem;

export interface GalleryItemsPage {
  items: GalleryItem[];
  total: number;
}

export interface GalleryItemMutationResult {
  /** Boards whose contents/counts changed for at least one confirmed success. */
  affectedBoardIds?: string[];
  failed: GalleryItemRef[];
  succeeded: GalleryItemRef[];
}

export const toGalleryItemKey = ({ kind, name }: GalleryItemRef): GalleryItemKey => `${kind}:${name}`;

export const shouldStarSelection = (items: readonly GalleryItem[], refs: readonly GalleryItemRef[]): boolean => {
  if (refs.length === 0) {
    return false;
  }

  const loadedItemsByKey = new Map(items.map((item) => [toGalleryItemKey(item), item]));
  return refs.some((ref) => !loadedItemsByKey.get(toGalleryItemKey(ref))?.starred);
};

export const parseGalleryItemKey = (key: string): GalleryItemRef => {
  const separatorIndex = key.indexOf(':');
  const kind = key.slice(0, separatorIndex);
  const name = key.slice(separatorIndex + 1);

  if ((kind === 'image' || kind === 'video') && name.length > 0) {
    return { kind, name };
  }

  return { kind: 'image', name: key };
};

export const toGalleryItemRef = ({ kind, name }: GalleryItem): GalleryItemRef => ({ kind, name });

export const isGalleryImageItem = (item: GalleryItem): item is GalleryImageItem => item.kind === 'image';

export const assertNeverGalleryItem = (item: never): never => {
  throw new Error(`Unexpected gallery item: ${String(item)}`);
};

const compareSqliteBinaryText = (a: string, b: string): number => (a === b ? 0 : a < b ? -1 : 1);

/**
 * Chronological comparison across the two timestamp shapes the gallery mixes:
 * backend rows carry SQLite's `created_at` ("2026-08-29 13:01:20.649") while
 * overlaid recents carry the queue's `submittedAt` (ISO, "2026-08-29T02:28:40.566Z").
 * Comparing the raw strings reads the 'T' separator as later than every
 * space-separated time on the same day, so an older overlaid recent would sort
 * above every newer backend image (and below them, with ascending order).
 */
const compareCreatedAt = (a: string, b: string): number =>
  compareSqliteBinaryText(normalizeServerTimestamp(a), normalizeServerTimestamp(b));

/** Mirrors the backend's time/kind/name order for mixed gallery items. */
export const compareGalleryItems = (
  a: GalleryItem,
  b: GalleryItem,
  { orderDir = 'DESC' }: { orderDir?: GalleryOrderDir } = {}
): number => {
  const direction = orderDir === 'ASC' ? 1 : -1;
  const chronologicalOrder = compareCreatedAt(a.createdAt, b.createdAt);

  if (chronologicalOrder !== 0) {
    return direction * chronologicalOrder;
  }

  const kindOrder = compareSqliteBinaryText(a.kind, b.kind);

  if (kindOrder !== 0) {
    return direction * kindOrder;
  }

  return direction * compareSqliteBinaryText(a.name, b.name);
};

type LegacyGalleryImage = GeneratedImageContract & Partial<Pick<GalleryImage, 'boardId' | 'imageCategory' | 'starred'>>;

export const legacyGeneratedImageToGalleryItem = (image: LegacyGalleryImage): GalleryImageItem => ({
  boardId: image.boardId ?? 'none',
  category: image.imageCategory ?? 'general',
  createdAt: image.createdAt ?? image.queuedAt,
  fullUrl: image.imageUrl,
  height: image.height,
  isIntermediate: false,
  kind: 'image',
  name: image.imageName,
  sourceQueueItemId: image.sourceQueueItemId,
  starred: image.starred ?? false,
  thumbnailUrl: image.thumbnailUrl,
  width: image.width,
});

export const galleryImageItemToGalleryImage = (item: GalleryImageItem): GalleryImage => ({
  boardId: item.boardId,
  createdAt: item.createdAt,
  height: item.height,
  imageCategory: item.category,
  imageName: item.name,
  imageUrl: item.fullUrl,
  queuedAt: item.createdAt,
  sourceQueueItemId: item.sourceQueueItemId ?? 'backend-gallery',
  starred: item.starred,
  thumbnailUrl: item.thumbnailUrl,
  width: item.width,
});

export const formatGalleryVideoDuration = (durationSeconds: number): string => {
  if (!Number.isFinite(durationSeconds) || durationSeconds < 0) {
    return '0:00';
  }

  const totalSeconds = Math.ceil(durationSeconds);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);

  if (totalMinutes < 60) {
    return `${totalMinutes}:${String(seconds).padStart(2, '0')}`;
  }

  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
};

/**
 * The media formats a gallery upload accepts, and the two things every upload surface needs
 * from them: the file input's `accept` list and the kind a picked or dropped file uploads as.
 *
 * Both derive from one table so a picker cannot offer less than the upload route takes — the
 * `accept` list and the classifier drifting apart is what left the gallery picker MP4-only
 * while the video panel's reference picker took every format the server ingests.
 *
 * It lives here rather than in a module of its own on purpose: every upload surface is in the
 * editor's initial graph, and a separate module is shared across enough chunk boundaries that
 * Rolldown emits it standalone — an extra initial request, which the architecture budget pins
 * exactly and refuses at any size. `items.ts` is already in that graph's `gallery-state` chunk.
 */

/**
 * Accepted for each kind in the browser's own terms. The server normalizes every accepted
 * upload to H.264 MP4 at ingest — foreign containers/codecs (.mov, HEVC, …) are remuxed or
 * transcoded and audio files are wrapped into waveform videos — so audio uploads as 'video'.
 *
 * Video and audio use wildcards, which the server backs with its own prefix check. Images do
 * not: the image route takes anything PIL can open and re-encodes it, but offering only the
 * three formats the app round-trips losslessly is a deliberate (and unchanged) narrowing. The
 * extension lists mirror the video upload route's and are the fallback for a file whose type
 * the OS could not map, which the browser then offers as application/octet-stream.
 */
const GALLERY_UPLOAD_FORMATS: Record<GalleryItemKind, { extensions: readonly string[]; mimes: readonly string[] }> = {
  image: {
    extensions: ['.png', '.jpg', '.jpeg', '.webp'],
    mimes: ['image/png', 'image/jpeg', 'image/webp'],
  },
  video: {
    extensions: [
      '.mp4',
      '.mov',
      '.m4v',
      '.webm',
      '.mkv',
      '.avi',
      '.mpg',
      '.mpeg',
      '.3gp',
      '.wmv',
      '.asf',
      '.mp3',
      '.m4a',
      '.aac',
      '.wav',
      '.flac',
      '.ogg',
      '.oga',
      '.opus',
      '.aiff',
      '.aif',
      '.wma',
    ],
    mimes: ['video/*', 'audio/*'],
  },
};

/**
 * Ordered so a kind added later classifies after the existing ones. Kept as a literal
 * rather than `Object.keys`: everything at this module's top level must stay a plain
 * declaration the bundler can drop, or the barrels that re-export `items.ts` are retained
 * in the editor's initial chunks. That is also why nothing here is precomputed into a Map —
 * classification runs once per picked file, so a scan of ~30 entries costs nothing.
 */
const GALLERY_UPLOAD_KINDS = ['image', 'video'] as const;

/**
 * The file input `accept` list for the given kinds. Advisory only — every browser offers an
 * "All files" escape hatch, so callers still classify what comes back.
 */
export const getGalleryUploadAccept = (kinds: readonly GalleryItemKind[]): string =>
  kinds
    .flatMap((kind) => [...GALLERY_UPLOAD_FORMATS[kind].mimes, ...GALLERY_UPLOAD_FORMATS[kind].extensions])
    .join(',');

/**
 * Which upload route a picked file belongs to, or null when no route takes it. An exact MIME
 * match wins over a wildcard, and both win over the filename, so a file the OS typed is never
 * routed by its extension.
 */
export const classifyGalleryUpload = (file: Pick<File, 'name' | 'type'>): { kind: GalleryItemKind } | null => {
  const mimeType = file.type.toLowerCase();

  // The legacy alias some Windows tools emit; the image route accepts it, but no picker
  // needs to advertise it, so it is classified without being offered.
  if (mimeType === 'image/jpg') {
    return { kind: 'image' };
  }
  for (const kind of GALLERY_UPLOAD_KINDS) {
    if (GALLERY_UPLOAD_FORMATS[kind].mimes.includes(mimeType)) {
      return { kind };
    }
  }
  for (const kind of GALLERY_UPLOAD_KINDS) {
    // `video/*` matches any `video/` type, mirroring ACCEPTED_*_MIME_PREFIXES on the routes.
    if (
      GALLERY_UPLOAD_FORMATS[kind].mimes.some((mime) => mime.endsWith('/*') && mimeType.startsWith(mime.slice(0, -1)))
    ) {
      return { kind };
    }
  }

  const lowerName = file.name.toLowerCase();

  for (const kind of GALLERY_UPLOAD_KINDS) {
    if (GALLERY_UPLOAD_FORMATS[kind].extensions.some((extension) => lowerName.endsWith(extension))) {
      return { kind };
    }
  }

  return null;
};
