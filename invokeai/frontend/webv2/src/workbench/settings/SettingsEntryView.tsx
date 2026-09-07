import type { SettingsTarget } from '@platform/ui/settings/contracts';

import { Box, Stack, Text } from '@chakra-ui/react';
import { Button } from '@platform/ui/Button';
import { RetryBoundary } from '@platform/ui/RetryBoundary';
import { resolveSettingsText } from '@platform/ui/settings/contracts';
import { getProjectWidgetInstance } from '@workbench/widgetState';
import { useOptionalWorkbenchSelector } from '@workbench/WorkbenchContext';
import { Suspense, use, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import type { SettingsEntry, SettingsSection } from './catalog';

import { settingsDialogStore } from './settingsDialogStore';
import { SettingsScopeLabel } from './SettingsScopeLabel';

const LoadedSetting = ({
  entry,
  target,
  surface,
}: {
  entry: SettingsEntry;
  target?: SettingsTarget;
  surface: 'quick' | 'dialog';
}) => {
  const { Field } = use(entry.resource.load());
  const attach = useCallback(
    (element: HTMLDivElement | null) => {
      if (!element || surface !== 'dialog' || settingsDialogStore.getSnapshot().entryId !== entry.field.id) {
        return;
      }
      const control = element.querySelector<HTMLElement>('input,button,[tabindex="0"]');
      element.scrollIntoView({ block: 'nearest' });
      control?.focus({ preventScroll: true });
      settingsDialogStore.patchSnapshot({ entryId: undefined });
    },
    [entry.field.id, surface]
  );
  return (
    <Box ref={attach}>
      <Field field={entry.field} surface={surface} target={target} />
    </Box>
  );
};

export const SettingsEntryView = ({
  entry,
  section,
  target: requestedTarget,
  surface = 'dialog',
  search = false,
  onReveal,
  showGroup = false,
}: {
  entry: SettingsEntry;
  section: SettingsSection;
  target?: SettingsTarget;
  surface?: 'quick' | 'dialog';
  search?: boolean;
  onReveal?: (sectionId: string, entryId: string) => void;
  showGroup?: boolean;
}) => {
  const { t } = useTranslation();
  const target = useOptionalWorkbenchSelector((snapshot) => {
    const project = snapshot.activeProject;
    if (requestedTarget && requestedTarget.projectId !== project.id) {
      return null;
    }
    const instance = requestedTarget?.instanceId
      ? project.widgetInstances[requestedTarget.instanceId]
      : section.widgetId
        ? getProjectWidgetInstance(project, section.widgetId)
        : undefined;
    if (entry.field.scope === 'instance' && (!instance || instance.typeId !== section.widgetId)) {
      return null;
    }
    return { projectId: project.id, instanceId: instance?.id };
  }, null);
  const reveal = useCallback(() => onReveal?.(section.id, entry.field.id), [onReveal, section.id, entry.field.id]);
  const loading = useMemo(
    () => (
      <Text role="status" fontSize="xs" color="fg.muted">
        {t('common.loading')}
      </Text>
    ),
    [t]
  );
  const unavailable = (entry.field.scope === 'instance' || entry.field.scope === 'project') && !target;
  const scope = entry.field.scope;
  const isDestination = search && entry.field.kind === 'custom';
  return (
    <>
      {showGroup && entry.field.group ? (
        <Text
          as="h3"
          pt={surface === 'quick' ? '2' : '5'}
          pb="1"
          fontWeight="600"
          fontSize={surface === 'quick' ? '2xs' : 'xs'}
          color="fg.muted"
        >
          {resolveSettingsText(entry.field.group, t)}
        </Text>
      ) : null}
      <Box
        data-setting-id={entry.field.id}
        py={surface === 'quick' ? '1.5' : '4'}
        borderBottomWidth="1px"
        borderColor="border.subtle"
      >
        {unavailable || isDestination ? (
          <Stack gap="2">
            <Text fontSize="sm" fontWeight="500">
              {resolveSettingsText(entry.field.label, t)}
            </Text>
            {entry.field.description ? (
              <Text fontSize="xs" color="fg.muted">
                {resolveSettingsText(entry.field.description, t)}
              </Text>
            ) : null}
            {unavailable ? (
              <Text fontSize="xs" color="fg.muted">
                {t(scope === 'instance' ? 'settingsDialog.instanceUnavailable' : 'settingsDialog.projectUnavailable')}
              </Text>
            ) : (
              <Button size="xs" variant="outline" alignSelf="start" onClick={reveal}>
                {t('settingsDialog.openEditor')}
              </Button>
            )}
          </Stack>
        ) : (
          <RetryBoundary
            key={`${entry.field.id}:${target?.projectId ?? ''}:${target?.instanceId ?? ''}`}
            retry={entry.resource.retry}
            message={t('settingsDialog.loadFailed')}
            retryLabel={t('common.retry')}
          >
            <Suspense fallback={loading}>
              <LoadedSetting entry={entry} target={target ?? undefined} surface={surface} />
            </Suspense>
          </RetryBoundary>
        )}
        {surface === 'dialog' && scope !== section.entries[0]?.field.scope ? (
          <Box mt="2">
            <SettingsScopeLabel scope={scope} />
          </Box>
        ) : null}
        {search && !isDestination ? (
          <Button size="2xs" variant="ghost" mt="1" onClick={reveal}>
            {t('settingsDialog.showInSection')}
          </Button>
        ) : null}
      </Box>
    </>
  );
};
