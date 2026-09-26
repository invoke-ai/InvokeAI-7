import type { WidgetViewProps } from '@workbench/widgetContracts';
import type { ChangeEvent } from 'react';

import { Badge, Box, Button, HStack, Input, NativeSelect, Stack, Switch, Text, Textarea } from '@chakra-ui/react';
import {
  getRemoteWorkerUrls,
  invalidateRemoteWorkerHealth,
  isRemoteWorkerEnabled,
  refreshRemoteWorkerHealth,
  remoteWorkersHealthStore,
  remoteWorkersStore,
  setRemoteWorkerEnabled,
  setRemoteWorkersSettings,
  type RemoteDispatchMode,
} from '@features/queue';
import { captureAccountScope } from '@platform/state/accountLifecycle';
import { apiFetchJson, getApiErrorMessage } from '@platform/transport/http';
import { ChevronDownIcon, ChevronUpIcon, PencilIcon, PowerIcon } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

const handleEnabledChange = (details: { checked: boolean }): void => {
  setRemoteWorkersSettings({ enabled: details.checked });
};

const handleDispatchModeChange = (event: ChangeEvent<HTMLSelectElement>): void => {
  setRemoteWorkersSettings({ dispatchMode: event.target.value as RemoteDispatchMode });
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

interface CredentialStatus {
  saved: boolean;
  email: string | null;
}

/** The password never enters queue settings, localStorage, or the workflow graph. */
const WorkerAuthRow = ({ enabled, slot, url }: { enabled: boolean; slot: number; url: string }) => {
  const [expanded, setExpanded] = useState(false);
  const workerEnabled = isRemoteWorkerEnabled(url);
  const availability = remoteWorkersHealthStore.useSnapshot().byUrl[url]?.status ?? 'checking';
  const availabilityLabel = !enabled
    ? 'Paused'
    : availability === 'online'
      ? 'Online'
      : availability === 'offline'
        ? 'Offline'
        : availability === 'login_required'
          ? 'Login required'
          : 'Checking';
  const availabilityColor = !enabled
    ? 'gray'
    : availability === 'online'
      ? 'green'
      : availability === 'offline'
        ? 'red'
        : availability === 'login_required'
          ? 'orange'
          : 'gray';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [saved, setSaved] = useState(false);
  const [checkingLogin, setCheckingLogin] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    let active = true;
    void apiFetchJson<CredentialStatus>(`/api/v1/remote_workers/credentials?url=${encodeURIComponent(url)}`)
      .then((status) => {
        if (!active) {
          return;
        }
        setSaved(status.saved);
        setEmail(status.email ?? '');
        setCheckingLogin(false);
        setMessage('');
      })
      .catch((error: unknown) => {
        if (active) {
          setCheckingLogin(false);
          setMessage(getApiErrorMessage(error, 'Could not load saved login status'));
        }
      });
    return () => {
      active = false;
    };
  }, [url]);

  const handleEmailChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setEmail(event.target.value);
  }, []);
  const handlePasswordChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setPassword(event.target.value);
  }, []);
  const refreshHealthAfterCredentialChange = useCallback(() => {
    invalidateRemoteWorkerHealth(url);
    if (enabled) {
      void refreshRemoteWorkerHealth([url]);
    }
  }, [enabled, url]);
  const handleSave = useCallback(async () => {
    setBusy(true);
    setMessage('');
    try {
      const status = await apiFetchJson<CredentialStatus>('/api/v1/remote_workers/credentials', {
        method: 'PUT',
        body: JSON.stringify({ url, email, password, remember_me: true }),
      });
      setSaved(status.saved);
      setEmail(status.email ?? '');
      setPassword('');
      refreshHealthAfterCredentialChange();
      setMessage('Login saved on this InvokeAI server.');
    } catch (error) {
      setMessage(getApiErrorMessage(error, 'Could not save worker login'));
    } finally {
      setBusy(false);
    }
  }, [url, email, password, refreshHealthAfterCredentialChange]);
  const handleRemove = useCallback(async () => {
    setBusy(true);
    setMessage('');
    try {
      await apiFetchJson<CredentialStatus>(`/api/v1/remote_workers/credentials?url=${encodeURIComponent(url)}`, {
        method: 'DELETE',
      });
      setSaved(false);
      setEmail('');
      setPassword('');
      refreshHealthAfterCredentialChange();
      setMessage('Saved login removed.');
    } catch (error) {
      setMessage(getApiErrorMessage(error, 'Could not remove worker login'));
    } finally {
      setBusy(false);
    }
  }, [url, refreshHealthAfterCredentialChange]);

  const toggleExpanded = useCallback(() => setExpanded((open) => !open), []);
  const toggleWorkerEnabled = useCallback(() => setRemoteWorkerEnabled(url, !workerEnabled), [url, workerEnabled]);

  return (
    <Box borderBottomColor="border.subtle" borderBottomWidth="1px" pb="2" pt="1">
      <HStack align="center" gap="1">
        <Button
          aria-expanded={expanded}
          aria-label={`Remote worker ${slot} settings`}
          color="fg"
          flex="1"
          h="auto"
          justifyContent="space-between"
          minW="0"
          onClick={toggleExpanded}
          px="1"
          py="2"
          size="sm"
          type="button"
          variant="ghost"
        >
          <HStack align="center" flex="1" gap="2" minW="0" textAlign="start">
            <Badge colorPalette={workerEnabled ? availabilityColor : 'gray'} flexShrink={0} variant="subtle">
              R{slot}
            </Badge>
            <Stack flex="1" gap="0" minW="0" opacity={workerEnabled ? 1 : 0.55}>
              <Text fontSize="sm" fontWeight="medium">
                Remote worker {slot}
              </Text>
              <Text color="fg.muted" fontFamily="mono" fontSize="2xs" overflowWrap="anywhere" whiteSpace="normal">
                {url}
              </Text>
            </Stack>
          </HStack>
          <Badge colorPalette={availabilityColor} flexShrink={0} variant="subtle">
            {availabilityLabel}
          </Badge>
        </Button>
        <Button
          aria-label={`${workerEnabled ? 'Disable' : 'Enable'} remote worker ${slot} for new jobs`}
          aria-pressed={workerEnabled}
          color={workerEnabled ? 'green.400' : 'fg.muted'}
          h="7"
          minW="7"
          onClick={toggleWorkerEnabled}
          px="0"
          size="xs"
          title={`${workerEnabled ? 'Disable' : 'Enable'} remote worker ${slot} for new jobs`}
          type="button"
          variant="ghost"
        >
          <PowerIcon size={15} />
        </Button>
        <Button
          aria-expanded={expanded}
          aria-label={`${expanded ? 'Collapse' : 'Expand'} remote worker ${slot} settings`}
          color="fg.muted"
          h="7"
          minW="6"
          onClick={toggleExpanded}
          px="0"
          size="xs"
          type="button"
          variant="ghost"
        >
          {expanded ? <ChevronUpIcon size={14} /> : <ChevronDownIcon size={14} />}
        </Button>
      </HStack>
      {expanded ? (
        <Stack gap="2" pb="2" pt="2" px="1">
          <Badge alignSelf="start" colorPalette={saved ? 'green' : 'gray'} variant="subtle">
            {checkingLogin ? 'Checking login' : saved ? 'Login saved' : 'No saved login'}
          </Badge>
          <Text color="fg.muted" fontSize="xs">
            Optional. For this worker's multi-user login, enter your own account credentials.
          </Text>
          <Input
            autoComplete="off"
            onChange={handleEmailChange}
            placeholder="Remote InvokeAI email"
            size="sm"
            type="email"
            value={email}
          />
          <Input
            autoComplete="new-password"
            onChange={handlePasswordChange}
            placeholder={saved ? 'New password (to replace saved login)' : 'Remote InvokeAI password'}
            size="sm"
            type="password"
            value={password}
          />
          <HStack gap="2">
            <Button disabled={busy || !email.trim() || !password} onClick={handleSave} size="sm">
              Save login
            </Button>
            <Button disabled={busy || !saved} onClick={handleRemove} size="sm" variant="outline">
              Remove login
            </Button>
          </HStack>
        </Stack>
      ) : null}
      {message ? (
        <Text color="fg.muted" fontSize="xs" px="1">
          {message}
        </Text>
      ) : null}
    </Box>
  );
};

/** Worker configuration only; do not imply connectivity from a configured URL or saved login. */
export const RemoteWorkersWidgetView = (_props: WidgetViewProps) => {
  const settings = remoteWorkersStore.useSnapshot();
  const urls = getRemoteWorkerUrls(settings.workerUrls);
  const accountId = captureAccountScope().accountId;
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showWorkerEditor, setShowWorkerEditor] = useState(false);
  const handleAdvancedChange = useCallback((details: { checked: boolean }) => {
    setShowAdvanced(details.checked);
  }, []);
  const toggleWorkerEditor = useCallback(() => setShowWorkerEditor((open) => !open), []);

  return (
    <Stack gap="5" p="3">
      <Stack gap="3">
        <HStack justify="space-between">
          <Text fontWeight="semibold">Distributed rendering</Text>
          <Badge colorPalette={settings.enabled ? 'green' : 'gray'}>{settings.enabled ? 'Enabled' : 'Disabled'}</Badge>
        </HStack>
        <Switch.Root checked={settings.enabled} onCheckedChange={handleEnabledChange}>
          <Switch.HiddenInput />
          <Switch.Control>
            <Switch.Thumb />
          </Switch.Control>
          <Switch.Label>Enable distributed rendering</Switch.Label>
        </Switch.Root>
        <Text color="fg.muted" fontSize="xs">
          Send new generations to Local, remote workers, or both. Worker logins are private to each InvokeAI user.
        </Text>
      </Stack>

      <Box borderColor="border.subtle" borderTopWidth="1px" pt="4">
        <Stack gap="2">
          <Text fontSize="sm" fontWeight="semibold">
            Dispatch
          </Text>
          <NativeSelect.Root size="sm" disabled={!settings.enabled}>
            <NativeSelect.Field value={settings.dispatchMode} onChange={handleDispatchModeChange}>
              <option value="mirror_all">Mirror to all</option>
              <option value="remotes_only">Remotes only</option>
              <option value="round_robin">Round-robin</option>
              <option value="auto_balance">Auto-balance</option>
            </NativeSelect.Field>
            <NativeSelect.Indicator />
          </NativeSelect.Root>
          <Text color="fg.muted" fontSize="xs">
            {settings.dispatchMode === 'mirror_all'
              ? 'Local and every remote render a variation of each invoke.'
              : settings.dispatchMode === 'remotes_only'
                ? 'Only remotes render. Local runs a short dispatch task, not image generation.'
                : settings.dispatchMode === 'round_robin'
                  ? 'Each invoke goes to one target, rotating through Local and the remotes.'
                  : 'Each invoke goes to one target with the fewest outstanding jobs dispatched in this browser. Ties rotate.'}
          </Text>
        </Stack>
      </Box>

      <Box borderColor="border.subtle" borderTopWidth="1px" pt="4">
        <Stack gap="2">
          <HStack justify="space-between" gap="2">
            <Text fontSize="sm" fontWeight="semibold">
              Workers
            </Text>
            <Badge colorPalette="gray" variant="subtle">
              {urls.length} configured
            </Badge>
          </HStack>
          {urls.length === 0 ? (
            <Text color={settings.enabled ? 'fg.warning' : 'fg.muted'} fontSize="xs">
              Add a valid http(s) worker URL to use distributed rendering.
            </Text>
          ) : (
            <Stack gap="1">
              {urls.map((url, index) => (
                <WorkerAuthRow enabled={settings.enabled} key={`${accountId}:${url}`} slot={index + 1} url={url} />
              ))}
            </Stack>
          )}
          <Button alignSelf="start" onClick={toggleWorkerEditor} size="xs" variant="outline">
            <PencilIcon size={13} />
            {showWorkerEditor ? 'Done editing addresses' : 'Edit worker addresses'}
          </Button>
          {showWorkerEditor ? (
            <Stack gap="1">
              <Text color="fg.muted" fontSize="xs">
                One URL per line. Order determines the R1, R2, ... worker labels. Changes are saved automatically.
              </Text>
              <Textarea
                aria-label="Remote worker URLs"
                fontFamily="mono"
                fontSize="sm"
                onChange={handleWorkerUrlsChange}
                placeholder={'http://192.168.1.100:9090\nhttp://192.168.1.101:9090'}
                resize="vertical"
                rows={3}
                value={settings.workerUrls}
              />
            </Stack>
          ) : null}
          <Text color="fg.muted" fontSize="xs">
            Paused means no availability checks while distributed rendering is off. When enabled: green = online, red =
            offline, orange = login required. The power icon excludes a worker from new jobs without stopping running
            ones. Offline workers remain configured and return to dispatch automatically when enabled. Passwords are
            encrypted on the primary instance; protect its runtime directory and use HTTPS across untrusted networks.
          </Text>
        </Stack>
      </Box>

      <Box borderColor="border.subtle" borderTopWidth="1px" pt="4">
        <Stack gap="3">
          <Text fontSize="sm" fontWeight="semibold">
            Model transfer
          </Text>
          <Switch.Root checked={settings.autoTransferMissingModels} onCheckedChange={handleAutoTransferChange}>
            <Switch.HiddenInput />
            <Switch.Control>
              <Switch.Thumb />
            </Switch.Control>
            <Switch.Label>Transfer missing models</Switch.Label>
          </Switch.Root>
          <Switch.Root checked={settings.keepRemoteCopies} onCheckedChange={handleKeepCopiesChange}>
            <Switch.HiddenInput />
            <Switch.Control>
              <Switch.Thumb />
            </Switch.Control>
            <Switch.Label>Keep copies on remote workers</Switch.Label>
          </Switch.Root>
          {settings.autoTransferMissingModels ? (
            <>
              <Switch.Root checked={showAdvanced} onCheckedChange={handleAdvancedChange}>
                <Switch.HiddenInput />
                <Switch.Control>
                  <Switch.Thumb />
                </Switch.Control>
                <Switch.Label>Advanced model transfer settings</Switch.Label>
              </Switch.Root>
              {showAdvanced ? (
                <Stack gap="1">
                  <Text fontSize="sm" fontWeight="medium">
                    Primary host address for model transfers (optional)
                  </Text>
                  <Input
                    fontFamily="mono"
                    onChange={handleTransferHostChange}
                    placeholder="Auto-detect primary host LAN IP"
                    size="sm"
                    value={settings.modelTransferHost}
                  />
                </Stack>
              ) : null}
            </>
          ) : null}
        </Stack>
      </Box>

      <Box borderColor="border.subtle" borderTopWidth="1px" pt="4">
        <Text color="fg.muted" fontSize="xs">
          Results follow your selected destination: Gallery uses the board selected when you invoke; Canvas receives
          staging candidates you can accept.
        </Text>
      </Box>
    </Stack>
  );
};
