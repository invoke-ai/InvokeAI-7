import { getGalleryDestinationBoardId } from '@features/gallery/contracts';

/** Resolve Auto at queue time, not when the user selects it, so subsequent Gallery changes are honored. */
export const resolveInvocationGalleryBoardId = (
  boardChoice: string | undefined,
  galleryValues: Record<string, unknown>
): string | null =>
  !boardChoice || boardChoice === 'auto' ? getGalleryDestinationBoardId(galleryValues) : boardChoice;
