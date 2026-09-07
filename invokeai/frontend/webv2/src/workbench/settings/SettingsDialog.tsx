import type { ChangeEvent, UIEvent } from 'react';

import { Box, Dialog, Flex, HStack, Icon, Input, NativeSelect, Stack, Text, VisuallyHidden } from '@chakra-ui/react';
import { useCapabilities } from '@features/identity';
import { useMountEffect } from '@platform/react/useMountEffect';
import { Button } from '@platform/ui/Button';
import { PanelHeader } from '@platform/ui/PanelHeader';
import { resolveSettingsText } from '@platform/ui/settings/contracts';
import {
  useActiveProjectId,
  useHasWorkbenchProvider,
  useWorkbenchQueries,
  useWorkbenchSubscription,
} from '@workbench/WorkbenchContext';
import { SearchIcon, XIcon } from 'lucide-react';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import type { SettingsSection } from './catalog';

import { searchSettings, settingsCatalog } from './catalog';
import {
  closeWorkbenchSettings,
  getSettingsSectionScroll,
  rememberSettingsSectionScroll,
  setSettingsQuery,
  setWorkbenchSettingsSection,
  settingsDialogStore,
} from './settingsDialogStore';
import { SettingsEntryView } from './SettingsEntryView';
import { SettingsScopeLabel } from './SettingsScopeLabel';
import { patchWorkbenchPreferences, useWorkbenchSettingsSelector } from './store';

/** Warm code, never mounted editors or data queries, before exposing section navigation. */
export const prepareSettingsDialog = async (): Promise<void> => {
  const resources = new Set(settingsCatalog.flatMap((section) => section.entries.map((entry) => entry.resource)));
  await Promise.allSettled([
    ...[...resources].map((resource) => resource.load()),
    import('./ApplicationSettingField').then((module) => module.prepareApplicationSettings()),
  ]);
};

const GROUPS = ['application', 'project', 'widgets', 'system'] as const;
const DIRECTION = { base: 'column', sm: 'row' } as const;
const SIDEBAR_WIDTH = { base: 'full', sm: '44', md: '56' };
const SIDEBAR_RIGHT_BORDER = { base: '0', sm: '1px' };
const SIDEBAR_BOTTOM_BORDER = { base: '1px', sm: '0' };
const SEARCH_PADDING = { base: '12', sm: '3' };
const MOBILE_DISPLAY = { base: 'block', sm: 'none' };
const DESKTOP_DISPLAY = { base: 'none', sm: 'block' };
const CONTENT_PADDING = { base: '4', md: '6' };
const clearSearch = () => setSettingsQuery('');
const rememberScroll = (event: UIEvent<HTMLDivElement>) => {
  const current = settingsDialogStore.getSnapshot();
  if (!current.query.trim()) {
    rememberSettingsSectionScroll(current.sectionId, event.currentTarget.scrollTop);
  }
};
const retrySave = () => {
  void patchWorkbenchPreferences({});
};

const ProjectLifetime = () => {
  const projectId = useActiveProjectId();
  const queries = useWorkbenchQueries();
  const subscribe = useWorkbenchSubscription();
  useMountEffect(() =>
    subscribe(() => {
      if (!queries.isActiveProject(projectId)) {
        closeWorkbenchSettings();
      }
    })
  );
  return null;
};

const SettingsDialog = () => {
  const { t } = useTranslation();
  const hasWorkbench = useHasWorkbenchProvider();
  const { canManageAppConfig } = useCapabilities();
  const state = settingsDialogStore.useSelector((snapshot) => snapshot);
  const error = useWorkbenchSettingsSelector((snapshot) => snapshot.error);
  const sections = settingsCatalog.filter((section) => section.id !== 'server' || canManageAppConfig);
  const active = sections.find((section) => section.id === state.sectionId) ?? sections[0];
  const searching = state.query.trim().length > 0;
  const matches = searchSettings(sections, state.query, t);
  const displayed = searching
    ? matches.filter((section) => !state.searchSection || section.id === state.searchSection)
    : [active];
  const count = matches.reduce((total, section) => total + section.entries.length, 0);
  const selectSection = useCallback(
    (sectionId: string) => {
      if (searching) {
        settingsDialogStore.patchSnapshot({ searchSection: sectionId || null });
      } else {
        setWorkbenchSettingsSection(sectionId);
      }
    },
    [searching]
  );
  const selectAllResults = useCallback(() => selectSection(''), [selectSection]);
  const changeSection = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => selectSection(event.target.value),
    [selectSection]
  );
  const changeQuery = useCallback((event: ChangeEvent<HTMLInputElement>) => setSettingsQuery(event.target.value), []);
  const attachBody = useCallback((element: HTMLDivElement | null) => {
    const current = settingsDialogStore.getSnapshot();
    if (element && !current.query.trim() && !current.entryId) {
      element.scrollTop = getSettingsSectionScroll(current.sectionId);
    }
  }, []);
  return (
    <Flex h="full" minH="0" direction={DIRECTION}>
      {hasWorkbench ? <ProjectLifetime /> : null}
      <Flex
        as="aside"
        w={SIDEBAR_WIDTH}
        flexShrink={0}
        direction="column"
        bg="bg"
        borderRightWidth={SIDEBAR_RIGHT_BORDER}
        borderBottomWidth={SIDEBAR_BOTTOM_BORDER}
        borderColor="border.subtle"
        minH="0"
      >
        <Box p="3" pe={SEARCH_PADDING}>
          <HStack position="relative">
            <Icon as={SearchIcon} position="absolute" left="2.5" boxSize="3.5" color="fg.muted" pointerEvents="none" />
            <Input
              aria-label={t('settingsDialog.search')}
              placeholder={t('settingsDialog.search')}
              value={state.query}
              ps="8"
              pe="8"
              size="sm"
              onChange={changeQuery}
            />
            {state.query ? (
              <Button
                aria-label={t('settingsDialog.clearSearch')}
                position="absolute"
                right="0"
                size="2xs"
                variant="ghost"
                onClick={clearSearch}
              >
                <XIcon />
              </Button>
            ) : null}
          </HStack>
        </Box>
        <Box display={MOBILE_DISPLAY} px="3" pb="3">
          <NativeSelect.Root size="sm">
            <NativeSelect.Field
              aria-label={t('settingsDialog.section')}
              value={searching ? (state.searchSection ?? '') : active.id}
              onChange={changeSection}
            >
              {searching ? <option value="">{t('settingsDialog.allResults')}</option> : null}
              {(searching ? matches : sections).map((section) => (
                <option key={section.id} value={section.id}>
                  {resolveSettingsText(section.label, t)}
                </option>
              ))}
            </NativeSelect.Field>
            <NativeSelect.Indicator />
          </NativeSelect.Root>
        </Box>
        <Box
          as="nav"
          aria-label={t('settings.title')}
          display={DESKTOP_DISPLAY}
          overflowY="auto"
          flex="1"
          minH="0"
          px="2"
          pb="3"
        >
          {searching ? (
            <Button
              w="full"
              justifyContent="space-between"
              size="sm"
              variant={!state.searchSection ? 'subtle' : 'ghost'}
              onClick={selectAllResults}
            >
              {t('settingsDialog.allResults')}
              <Text fontSize="xs">{count}</Text>
            </Button>
          ) : null}
          {GROUPS.map((group) => {
            const groupSections = (searching ? matches : sections).filter((section) => section.group === group);
            if (!groupSections.length) {
              return null;
            }
            return (
              <Stack key={group} gap="0.5" mt="4">
                <Text px="2" pb="1" fontSize="2xs" fontWeight="600" color="fg.muted" textTransform="uppercase">
                  {t(`settingsDialog.groups.${group}`)}
                </Text>
                {groupSections.map((section) => (
                  <SettingsNavigationItem
                    key={section.id}
                    section={section}
                    selected={(searching ? state.searchSection : active.id) === section.id}
                    searching={searching}
                    onSelect={selectSection}
                  />
                ))}
              </Stack>
            );
          })}
        </Box>
      </Flex>
      <Flex direction="column" flex="1" minW="0" minH="0">
        <Dialog.Header asChild>
          <PanelHeader px="4" pe="12" py="0">
            <HStack gap="2">
              <Icon as={searching ? SearchIcon : active.icon} boxSize="4" />
              <Dialog.Title fontSize="xs" fontWeight="700">
                <VisuallyHidden>{t('settings.title')}: </VisuallyHidden>
                {searching ? t('settingsDialog.results') : resolveSettingsText(active.label, t)}
              </Dialog.Title>
            </HStack>
          </PanelHeader>
        </Dialog.Header>
        {error ? (
          <HStack role="alert" px="4" py="2" bg="bg.error">
            <Text fontSize="xs" color="fg.error" flex="1">
              {error}
            </Text>
            <Button size="xs" onClick={retrySave}>
              {t('common.retry')}
            </Button>
          </HStack>
        ) : null}
        <VisuallyHidden role="status">{searching ? t('settingsDialog.resultCount', { count }) : ''}</VisuallyHidden>
        <Box
          key={searching ? `search:${state.searchSection ?? ''}` : active.id}
          ref={attachBody}
          onScroll={rememberScroll}
          overflowY="auto"
          flex="1"
          minH="0"
          px={CONTENT_PADDING}
          pb="4"
        >
          {displayed.map((section) => (
            <SettingsSectionContent
              key={section.id}
              section={section}
              search={searching}
              onReveal={setWorkbenchSettingsSection}
            />
          ))}
          {searching && !displayed.length ? (
            <Stack align="center" py="12" gap="3">
              <Text color="fg.muted">{t('settingsDialog.noResults')}</Text>
              <Button size="sm" variant="outline" onClick={clearSearch}>
                {t('settingsDialog.clearSearch')}
              </Button>
            </Stack>
          ) : null}
        </Box>
      </Flex>
    </Flex>
  );
};

const SettingsNavigationItem = ({
  section,
  selected,
  searching,
  onSelect,
}: {
  section: SettingsSection;
  selected: boolean;
  searching: boolean;
  onSelect: (sectionId: string) => void;
}) => {
  const { t } = useTranslation();
  const select = useCallback(() => onSelect(section.id), [onSelect, section.id]);
  return (
    <Button
      w="full"
      justifyContent="start"
      size="sm"
      variant={selected ? 'subtle' : 'ghost'}
      aria-current={selected ? 'page' : undefined}
      onClick={select}
    >
      <Icon as={section.icon} boxSize="3.5" flexShrink={0} />
      <Text flex="1" textAlign="start" whiteSpace="normal">
        {resolveSettingsText(section.label, t)}
      </Text>
      {searching ? <Text fontSize="2xs">{section.entries.length}</Text> : null}
    </Button>
  );
};

const SettingsSectionContent = ({
  section,
  search,
  onReveal,
}: {
  section: SettingsSection;
  search: boolean;
  onReveal: (sectionId: string, entryId?: string) => void;
}) => {
  const { t } = useTranslation();
  const target = settingsDialogStore.useSelector((snapshot) =>
    snapshot.sectionId === section.id ? snapshot.target : undefined
  );
  return (
    <Box>
      {!search && section.entries[0] ? (
        <Box pt="3">
          <SettingsScopeLabel scope={section.entries[0].field.scope} />
        </Box>
      ) : null}
      {search ? (
        <Stack gap="0.5" pt="5">
          <Text as="h3" fontWeight="600" fontSize="sm">
            {resolveSettingsText(section.label, t)}
          </Text>
          {section.entries[0] ? <SettingsScopeLabel scope={section.entries[0].field.scope} /> : null}
        </Stack>
      ) : null}
      {section.entries.map((entry, index) => (
        <SettingsEntryView
          key={entry.field.id}
          entry={entry}
          section={section}
          target={target}
          search={search}
          onReveal={onReveal}
          showGroup={Boolean(
            entry.field.group &&
            resolveSettingsText(entry.field.group, t) !==
              (section.entries[index - 1]?.field.group
                ? resolveSettingsText(section.entries[index - 1].field.group!, t)
                : '')
          )}
        />
      ))}
    </Box>
  );
};
export default SettingsDialog;
