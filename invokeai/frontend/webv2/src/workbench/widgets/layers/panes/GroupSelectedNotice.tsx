import { Text } from '@chakra-ui/react';
import { getDocumentNode } from '@workbench/canvas-engine/api';
import { useActiveProjectSelector } from '@workbench/WorkbenchContext';
import { useTranslation } from 'react-i18next';

/**
 * Leaf tools and editors cannot act on a group: name the state instead of
 * silently refusing. Renders nothing unless a group really is selected, so
 * ungated callers stay honest for leaves and for no selection at all.
 */
export const GroupSelectedNotice = ({ hint }: { hint?: string }) => {
  const { t } = useTranslation();
  const isGroupSelected = useActiveProjectSelector((project) => {
    const { document } = project.canvas;
    return getDocumentNode(document, document.selectedLayerId)?.type === 'group';
  });
  if (!isGroupSelected) {
    return null;
  }
  return (
    <Text color="fg.muted" fontSize="xs" minW="0">
      {hint ?? t('widgets.layers.groupSelectedHint')}
    </Text>
  );
};
