import { Dialog, Portal, Text } from '@chakra-ui/react';
import { useMountEffect } from '@platform/react/useMountEffect';
import { CloseButton } from '@platform/ui';
import { RetryBoundary } from '@platform/ui/RetryBoundary';
import { registerHotkeyModalLayer } from '@workbench/hotkeys/modalLayer';
import { Suspense, use, useMemo, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { settingsDialogResource as dialogResource } from './dialogResource';
import { closeWorkbenchSettings, settingsDialogStore } from './settingsDialogStore';
const isEditingTarget = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName));

/** `/` from anywhere in the dialog jumps to its search, unless a field is being edited. */
const focusSearchOnSlash = (event: KeyboardEvent<HTMLDivElement>) => {
  if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey || isEditingTarget(event.target)) {
    return;
  }

  const search = event.currentTarget.querySelector<HTMLInputElement>('[data-settings-search]');

  if (search) {
    event.preventDefault();
    search.focus();
    search.select();
  }
};

const LoadedDialog = () => {
  const { default: SettingsDialog } = use(dialogResource.load());
  return <SettingsDialog />;
};

const SettingsModalLayer = () => {
  useMountEffect(() => registerHotkeyModalLayer('settings'));
  return null;
};

const getReturnFocus = () => {
  const element = settingsDialogStore.getSnapshot().returnFocus;
  return element?.isConnected ? element : null;
};
const handleOpenChange = ({ open }: { open: boolean }) => {
  if (!open) {
    closeWorkbenchSettings();
  }
};

/** The presence owner remains mounted; only the editor body is deferred. */
export const SettingsDialogHost = () => {
  const { t } = useTranslation();
  const loading = useMemo(
    () => (
      <Dialog.Body p="5">
        <Dialog.Title>{t('settings.title')}</Dialog.Title>
        <Text role="status">{t('common.loading')}</Text>
      </Dialog.Body>
    ),
    [t]
  );
  const isOpen = settingsDialogStore.useSelector((snapshot) => snapshot.isOpen);
  const generation = settingsDialogStore.useSelector((snapshot) => snapshot.generation);
  return (
    <Dialog.Root
      key={generation}
      open={isOpen}
      lazyMount
      unmountOnExit
      scrollBehavior="inside"
      placement="center"
      size="xl"
      finalFocusEl={getReturnFocus}
      onOpenChange={handleOpenChange}
    >
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content
            aria-label={t('settings.title')}
            h="min(48rem, calc(100dvh - 2rem))"
            onKeyDown={focusSearchOnSlash}
            maxW="64rem"
            w="calc(100dvw - 2rem)"
            overflow="hidden"
            p="0"
          >
            <SettingsModalLayer />
            <RetryBoundary
              retry={dialogResource.retry}
              message={t('settingsDialog.loadFailed')}
              retryLabel={t('common.retry')}
            >
              <Suspense fallback={loading}>
                <LoadedDialog />
              </Suspense>
            </RetryBoundary>
            <Dialog.CloseTrigger asChild>
              <CloseButton aria-label={t('common.close')} />
            </Dialog.CloseTrigger>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
};
