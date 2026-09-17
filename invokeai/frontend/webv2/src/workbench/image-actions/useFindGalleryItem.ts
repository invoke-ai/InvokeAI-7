import type { GalleryItemRef } from '@features/gallery/contracts';
import type { GalleryRevealTicket } from '@workbench/image-actions/revealGalleryItem';
import type { WidgetRegion } from '@workbench/layoutContracts';
import type { Project } from '@workbench/projectContracts';

import { claimGalleryNavigationSequence, isGalleryNavigationCurrent } from '@features/gallery/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useOpenWorkbenchWidget } from '@workbench/useOpenWorkbenchWidget';
import { useWorkbenchCommands, useWorkbenchQueries } from '@workbench/WorkbenchContext';
import { useCallback } from 'react';

/**
 * Where to raise the grid, when it is already somewhere. `openWorkbenchWidget`
 * picks a region from the MANIFEST rather than from the layout, and the reducer
 * then adopts the existing instance into that region WITHOUT vacating the one
 * it came from — so an unqualified open lists one grid in two regions at once
 * and leaves it permanently in the centre tab strip. Naming the region it
 * already occupies keeps the open a raise.
 *
 * Centre is the last resort: it is Preview's home, and the two would contest
 * one slot. A project with no grid at all falls through to default placement.
 */
const SIDE_REGIONS: readonly WidgetRegion[] = ['right', 'left', 'bottom', 'center'];

const getGalleryRegions = (project: Project): WidgetRegion[] =>
  SIDE_REGIONS.filter((region) =>
    project.widgetRegions[region].instanceIds.some(
      (instanceId) => project.widgetInstances[instanceId]?.typeId === 'gallery'
    )
  );

/**
 * "Find in gallery", as the Generate and Video panels offer it on the media
 * they are conditioning on: bring the Gallery and Preview widgets on screen,
 * then reveal the item in the grid. Unlike the image map's reveal this DOES
 * rearrange the workspace — the panels are the far side of the app from the
 * grid, and a selection the user cannot see is not a find.
 *
 * Preview is raised first so that the grid wins if the two share a region:
 * the gesture is named for the grid, and Preview follows the selection anyway
 * once it is on screen. Both are raised on the press itself, ahead of the
 * reveal, so the gesture reads as immediate; a widget no region can host is
 * simply skipped, and the reveal still runs.
 *
 * The reveal is fetched on the press. Loading it eagerly pulled the gallery
 * item/transfer barrel into the editor's initial graph, costing two more
 * initial script requests (measured against the request-count budgets), for a
 * control most sessions never touch. Its own sequence number is claimed HERE,
 * before the import, so a press still takes its place in the global ordering
 * at the moment it happened rather than whenever the chunk lands.
 */
export const useFindGalleryItem = (): ((ref: GalleryItemRef) => void) => {
  const commands = useWorkbenchCommands();
  const queries = useWorkbenchQueries();
  const queryClient = useQueryClient();
  const openWorkbenchWidget = useOpenWorkbenchWidget();

  return useCallback(
    (ref: GalleryItemRef) => {
      const activeProject = queries.getSnapshot().activeProject;
      // Minted here, not inside the import below: both the ordering and the
      // project fence describe the PRESS, and reading either after the chunk
      // lands would pin whatever the workspace had become by then.
      const ticket: GalleryRevealTicket = {
        projectId: activeProject.id,
        sequence: claimGalleryNavigationSequence(),
      };
      const galleryRegions = getGalleryRegions(activeProject);

      openWorkbenchWidget('preview', { preferredRegions: ['center'], requireCenterView: true });
      openWorkbenchWidget('gallery', galleryRegions.length > 0 ? { preferredRegions: galleryRegions } : undefined);

      void import('@workbench/image-actions/revealGalleryItem')
        .then(({ revealGalleryItem }) => revealGalleryItem({ commands, queries, queryClient }, ref, ticket))
        .catch((error: unknown) => {
          // Either the chunk 404'd (a tab left open across a redeploy) or the
          // media is gone from the gallery — an ordinary state, since a
          // reference outlives the image it was taken from. The widgets are
          // already raised, so failing silently would leave the user with a
          // rearranged workspace and no explanation for the grid not moving.
          //
          // Only for the gesture still in force: a press the user has since
          // superseded, or left behind in another project, has no claim on
          // their attention. The claim itself is not given back — a later press
          // was a later intent, and it stands even though it could not be met.
          if (!isGalleryNavigationCurrent(ticket.sequence) || !queries.isActiveProject(ticket.projectId)) {
            return;
          }

          commands.notifications.reportError({
            area: 'find-in-gallery',
            message: error instanceof Error ? error.message : String(error),
            namespace: 'gallery',
          });
        });
    },
    [commands, openWorkbenchWidget, queries, queryClient]
  );
};
