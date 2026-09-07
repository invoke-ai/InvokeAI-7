import { Icon, Menu } from '@chakra-ui/react';
import { MenuContent } from '@platform/ui/Menu';
import { Link } from '@tanstack/react-router';
import { ArrowRightIcon, CopyIcon, FileDownIcon, PencilIcon, PinIcon, PinOffIcon, Trash2Icon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/**
 * The per-project action menu's content. Right-click and the overflow button
 * offer the same things in the same order everywhere; the single mounted
 * instance and its dialogs live in `ProjectActionsMenuHost`.
 */
export const ProjectActionsMenuBody = ({
  isCompatible,
  isPinned,
  onDelete,
  onDuplicate,
  onExport,
  onRename,
  onTogglePin,
  projectSearch,
}: {
  isCompatible: boolean;
  isPinned: boolean;
  projectSearch: { project: string };
  onDelete: () => void;
  onDuplicate: () => void;
  onExport: () => void;
  onRename: () => void;
  onTogglePin: () => void;
}) => {
  const { t } = useTranslation();

  return (
    <MenuContent minW="44">
      {isCompatible ? (
        <Menu.Item asChild value="open">
          <Link search={projectSearch} to="/app">
            <Icon as={ArrowRightIcon} boxSize="3.5" />
            {t('common.open')}
          </Link>
        </Menu.Item>
      ) : (
        <Menu.Item aria-label={t('projects.file.updateClient')} disabled value="open">
          <Icon as={ArrowRightIcon} boxSize="3.5" />
          {t('common.open')}
        </Menu.Item>
      )}
      <Menu.Item value="pin" onClick={onTogglePin}>
        <Icon as={isPinned ? PinOffIcon : PinIcon} boxSize="3.5" />
        {isPinned ? t('projects.unpin') : t('projects.pin')}
      </Menu.Item>
      <Menu.Separator />
      <Menu.Item disabled={!isCompatible} value="rename" onClick={onRename}>
        <Icon as={PencilIcon} boxSize="3.5" />
        {t('projects.renameWithEllipsis')}
      </Menu.Item>
      <Menu.Item disabled={!isCompatible} value="duplicate" onClick={onDuplicate}>
        <Icon as={CopyIcon} boxSize="3.5" />
        {t('common.duplicate')}
      </Menu.Item>
      <Menu.Item disabled={!isCompatible} value="export" onClick={onExport}>
        <Icon as={FileDownIcon} boxSize="3.5" />
        {t('common.export')}
      </Menu.Item>
      <Menu.Separator />
      <Menu.Item data-danger="" value="delete" onClick={onDelete}>
        <Icon as={Trash2Icon} boxSize="3.5" />
        {t('common.delete')}…
      </Menu.Item>
    </MenuContent>
  );
};
