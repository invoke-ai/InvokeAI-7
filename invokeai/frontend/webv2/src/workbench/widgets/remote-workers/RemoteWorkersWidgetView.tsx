import type { WidgetViewProps } from '@workbench/widgetContracts';
import type { ChangeEvent } from 'react';

import { Badge, Box, HStack, Input, Stack, Switch, Text, Textarea } from '@chakra-ui/react';
import { getRemoteWorkerUrls, remoteWorkersStore, setRemoteWorkersSettings } from '@features/queue';

const handleEnabledChange = (details: { checked: boolean }): void => {
  setRemoteWorkersSettings({ enabled: details.checked });
};

const handleWorkerUrlsChange = (event: ChangeEvent<HTMLTextAreaElement>): void => {
  setRemoteWorkersSettings({ workerUrls: event.target.value });
};

const handleAutoTransferChange = (details: { checked: boolean }): void => {
  setRemoteWorkersSettings({ autoTransferMissingModels: details.checked });
};

const handleKeepCopiesChange = (details: { checked: boolean }): void => {
  setRemoteWorkersSettings({ keepRemoteCopies: details.checked });
};

const handleTransferHostChange = (event: ChangeEvent<HTMLInputElement>): void => {
  setRemoteWorkersSettings({ modelTransferHost: event.target.value });
};

/** Minimal first-pass control surface, not a live worker-monitoring dashboard. */
export const RemoteWorkersWidgetView = (_props: WidgetViewProps) => {
  const settings = remoteWorkersStore.useSnapshot();
  const urls = getRemoteWorkerUrls(settings.workerUrls);
  return (
    <Stack gap="4" p="3">
      <HStack justify="space-between">
        <Text fontWeight="semibold">Distributed rendering</Text>
        <Badge colorPalette={settings.enabled ? 'green' : 'gray'}>{settings.enabled ? 'On' : 'Off'}</Badge>
      </HStack>
      <Switch.Root checked={settings.enabled} onCheckedChange={handleEnabledChange}>
        <Switch.HiddenInput />
        <Switch.Control>
          <Switch.Thumb />
        </Switch.Control>
        <Switch.Label>Mirror new Gallery generations</Switch.Label>
      </Switch.Root>
      <Text color="fg.muted" fontSize="xs">
        Windows keeps rendering. Each enabled remote receives a variation with its own seed. This first test mirrors
        Gallery submissions only; Canvas results stay local.
      </Text>
      <Stack gap="1">
        <Text fontSize="sm" fontWeight="medium">
          Remote worker URLs
        </Text>
        <Textarea
          fontFamily="mono"
          fontSize="sm"
          onChange={handleWorkerUrlsChange}
          placeholder={'http://192.168.1.100:9090\nhttp://192.168.1.101:9090'}
          resize="vertical"
          rows={3}
          value={settings.workerUrls}
        />
        <Text color="fg.muted" fontSize="xs">
          One URL per line. {urls.length} valid remote worker(s) configured.
        </Text>
        {settings.enabled && urls.length === 0 ? (
          <Text color="fg.warning" fontSize="xs">
            Add a valid http(s) worker URL to activate mirroring.
          </Text>
        ) : null}
      </Stack>
      <Switch.Root checked={settings.autoTransferMissingModels} onCheckedChange={handleAutoTransferChange}>
        <Switch.HiddenInput />
        <Switch.Control>
          <Switch.Thumb />
        </Switch.Control>
        <Switch.Label>Transfer missing single-file models</Switch.Label>
      </Switch.Root>
      <Switch.Root checked={settings.keepRemoteCopies} onCheckedChange={handleKeepCopiesChange}>
        <Switch.HiddenInput />
        <Switch.Control>
          <Switch.Thumb />
        </Switch.Control>
        <Switch.Label>Keep copies on remote workers</Switch.Label>
      </Switch.Root>
      <Stack gap="1">
        <Text fontSize="sm" fontWeight="medium">
          Model transfer host (optional)
        </Text>
        <Input
          fontFamily="mono"
          onChange={handleTransferHostChange}
          placeholder="Auto-detect Windows LAN IP"
          size="sm"
          value={settings.modelTransferHost}
        />
      </Stack>
      <Box borderColor="border.subtle" borderTopWidth="1px" pt="3">
        <Text color="fg.muted" fontSize="xs">
          Requires the invokeai-remote-worker node pack on this Windows InvokeAI. An existing manual Mirror node takes
          precedence. The captured Gallery board is used for Board=Auto. URLs/settings are stored in this browser;
          credentials are not stored here.
        </Text>
      </Box>
    </Stack>
  );
};
