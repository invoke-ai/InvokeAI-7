import { Icon, Menu, Portal } from '@chakra-ui/react';
import { useMountEffect } from '@platform/react/useMountEffect';
import { Button } from '@platform/ui/Button';
import { MenuContent } from '@platform/ui/Menu';
import { MiddleTruncate } from '@platform/ui/MiddleTruncate';
import { Link } from '@tanstack/react-router';
import { useProjectLibrarySelector } from '@workbench/projects/library';
import { refreshOpenProjects, useOpenProjectsSelector } from '@workbench/projects/openProjects';
import { ArrowLeftIcon, CheckIcon } from 'lucide-react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Hide editor re-entry only for a known-empty saved session. Unknown sessions retain entry so the editor can
 * resolve them.
 */

const MENU_POSITIONING = { placement: 'bottom-start' } as const;

export const OpenProjectsControl = () => {
  const { t } = useTranslation();
  const status = useOpenProjectsSelector((snapshot) => snapshot.status);
  const openProjectIds = useOpenProjectsSelector((snapshot) => snapshot.ids);
  const activeProjectId = useOpenProjectsSelector((snapshot) => snapshot.activeId);
  const summaries = useProjectLibrarySelector((snapshot) => snapshot.summaries);

  useMountEffect(() => {
    void refreshOpenProjects();
  });

  const openProjects = useMemo(() => {
    if (!openProjectIds) {
      return [];
    }

    const nameById = new Map(summaries.map((summary) => [summary.id, summary.name]));

    return openProjectIds.map((id) => ({ id, name: nameById.get(id) ?? null }));
  }, [openProjectIds, summaries]);

  if (status !== 'ready') {
    return null;
  }

  if (openProjectIds === null) {
    return <OpenEditorButton />;
  }

  if (openProjects.length === 0) {
    return null;
  }

  const activeName = openProjects.find((project) => project.id === activeProjectId)?.name;
  const triggerLabel = activeName ?? t('launchpad.openProjects.label');

  return (
    <Menu.Root positioning={MENU_POSITIONING}>
      <Menu.Trigger asChild>
        <Button
          aria-label={activeName ? t('launchpad.openProjects.activeLabel', { name: activeName }) : triggerLabel}
          maxW="56"
          size="xs"
          variant="subtle"
        >
          <ArrowLeftIcon />
          <MiddleTruncate text={triggerLabel} />
        </Button>
      </Menu.Trigger>
      <Portal>
        <Menu.Positioner>
          <MenuContent minW="15rem">
            {openProjects.map((project) => (
              <OpenProjectItem
                id={project.id}
                isActive={project.id === activeProjectId}
                key={project.id}
                name={project.name}
              />
            ))}
          </MenuContent>
        </Menu.Positioner>
      </Portal>
    </Menu.Root>
  );
};

const OpenProjectItem = ({ id, isActive, name }: { id: string; isActive: boolean; name: string | null }) => {
  const search = useMemo(() => ({ project: id }), [id]);

  return (
    <Menu.Item asChild value={id}>
      <Link search={search} to="/app">
        <Icon as={CheckIcon} boxSize="3.5" opacity={isActive ? 1 : 0} />
        <Menu.ItemText>{name ?? id}</Menu.ItemText>
      </Link>
    </Menu.Item>
  );
};

const OpenEditorButton = () => {
  const { t } = useTranslation();

  return (
    <Button asChild size="xs" variant="subtle">
      <Link to="/app">
        <ArrowLeftIcon />
        {t('launchpad.openProjects.openEditor')}
      </Link>
    </Button>
  );
};
