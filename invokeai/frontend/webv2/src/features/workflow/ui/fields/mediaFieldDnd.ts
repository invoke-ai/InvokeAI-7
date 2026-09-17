import { isGalleryItemDragData } from '@features/gallery/utility';

/**
 * Drop plumbing for the media (image/video) workflow field inputs: a gallery
 * item dragged onto a field's input row sets that field's value.
 */

export type WorkflowMediaKind = 'image' | 'video';

export interface WorkflowMediaDropItem {
  kind: WorkflowMediaKind;
  name: string;
}

export const getWorkflowMediaFieldDropId = (fieldKey: string): string => `workflow-media-field:${fieldKey}`;

/** Every dragged gallery item of `kind`; empty when the drag carries anything else. */
export const getWorkflowMediaFieldDropItems = (
  activeData: unknown,
  kind: WorkflowMediaKind
): WorkflowMediaDropItem[] =>
  isGalleryItemDragData(activeData) && activeData.items.every((item) => item.kind === kind)
    ? activeData.items.map((item) => ({ kind, name: item.name }))
    : [];

/**
 * Resolves a gallery drag payload to the single item a media field can accept,
 * or null. Multi-item drags are rejected outright: a single-value field
 * silently keeping only the first of several dragged items would misread the
 * user's intent.
 */
export const getWorkflowMediaFieldDropItem = (
  activeData: unknown,
  kind: WorkflowMediaKind
): WorkflowMediaDropItem | null => {
  const items = getWorkflowMediaFieldDropItems(activeData, kind);

  return items.length === 1 ? (items[0] ?? null) : null;
};
