import type { GalleryBoard } from '@features/gallery/contracts';

import { createListCollection, Stack, Text } from '@chakra-ui/react';
import { getGalleryBoardGroups, getGallerySettings } from '@features/gallery/contracts';
import { galleryBoardsOptions } from '@features/gallery/queries';
import { Select } from '@platform/ui/Select';
import { useQuery } from '@tanstack/react-query';
import { getProjectWidgetValues } from '@workbench/widgetState';
import { shallowEqual, useActiveProjectSelector, useWorkbenchCommands } from '@workbench/WorkbenchContext';
import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

const EMPTY_BOARDS: GalleryBoard[] = [];

export const RoutingBoardSelect = ({ boardId }: { boardId: string }) => {
  const { t } = useTranslation();
  const { generation } = useWorkbenchCommands();
  const galleryValues = useActiveProjectSelector((project) => getProjectWidgetValues(project, 'gallery'), shallowEqual);
  const projectName = useActiveProjectSelector((project) => project.name);
  const settings = getGallerySettings(galleryValues);
  const projectBoardId = typeof galleryValues.projectBoardId === 'string' ? galleryValues.projectBoardId : null;
  const { data: boards = EMPTY_BOARDS } = useQuery(
    galleryBoardsOptions({
      includeArchived: settings.showArchivedBoards,
      // Date boards are virtual collections, not writable image destinations.
      includeDateBoards: false,
      orderBy: settings.boardOrderBy,
      orderDir: settings.boardOrderDir,
    })
  );
  const groups = useMemo(
    () =>
      getGalleryBoardGroups({
        boards,
        projectBoardId,
        projectName,
        searchTerm: '',
        showArchived: settings.showArchivedBoards,
        showDates: false,
        showOtherProjects: settings.showOtherProjectBoards,
        t,
      }),
    [boards, projectBoardId, projectName, settings.showArchivedBoards, settings.showOtherProjectBoards, t]
  );
  const collection = useMemo(() => {
    const options = [
      { label: 'Auto', value: 'auto' },
      { label: 'None', value: 'none' },
      ...[...groups.yourBoards, ...groups.archivedBoards]
        .filter((board) => board.kind === 'board')
        .map((board) => ({ label: board.name, value: board.id })),
    ];
    if (boardId !== 'auto' && boardId !== 'none' && !options.some((option) => option.value === boardId)) {
      options.splice(2, 0, { label: `Selected board (${boardId})`, value: boardId });
    }
    return createListCollection({ items: options });
  }, [boardId, groups.archivedBoards, groups.yourBoards]);
  const handleChange = useCallback(
    ({ value }: { value: string[] }) => {
      if (value[0] !== undefined) {
        generation.setGalleryBoard(value[0]);
      }
    },
    [generation]
  );
  const selectedValue = useMemo(() => [boardId], [boardId]);

  return (
    <Stack gap="1">
      <Text fontSize="xs">Board</Text>
      <Select
        aria-label="Board"
        collection={collection}
        portalled={false}
        size="xs"
        value={selectedValue}
        w="full"
        onValueChange={handleChange}
      />
    </Stack>
  );
};
