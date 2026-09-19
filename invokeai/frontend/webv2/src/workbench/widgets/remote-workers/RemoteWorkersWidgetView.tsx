import type { WidgetViewProps } from '@workbench/widgetContracts';
import type { ChangeEvent } from 'react';

import { Badge, Box, Button, HStack, Input, Stack, Switch, Text, Textarea } from '@chakra-ui/react';
import { getRemoteWorkerUrls, remoteWorkersStore, setRemoteWorkersSettings } from '@features/queue';
import { captureAccountScope } from '@platform/state/accountLifecycle';
import { apiFetchJson, getApiErrorMessage } from '@platform/transport/http';
import { useCallback, useEffect, useState } from 'react';

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

interface CredentialStatus {
  saved: boolean;
  email: string | null;
}

/** The password never enters queue settings, localStorage, or the workflow graph. */
const WorkerAuthRow = ({ url }: { url: string }) => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [saved, setSaved] = useState(false);
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
        setMessage('');
      })
      .catch((error: unknown) => {
        if (active) {
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
      setMessage('Login saved on this InvokeAI server.');
    } catch (error) {
      setMessage(getApiErrorMessage(error, 'Could not save worker login'));
    } finally {
      setBusy(false);
    }
  }, [url, email, password]);
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
      setMessage('Saved login removed.');
    } catch (error) {
      setMessage(getApiErrorMessage(error, 'Could not remove worker login'));
    } finally {
      setBusy(false);
    }
  }, [url]);

  return (
    <Box borderColor="border.subtle" borderWidth="1px" borderRadius="md" p="3">
      <Stack gap="2">
        <HStack justify="space-between" gap="2" flexWrap="wrap">
          <Text fontFamily="mono" fontSize="xs" overflowWrap="anywhere">
            {url}
          </Text>
          <Badge colorPalette={saved ? 'green' : 'gray'}>{saved ? 'Login saved' : 'No saved login'}</Badge>
        </HStack>
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
        {message ? (
          <Text color="fg.muted" fontSize="xs">
            {message}
          </Text>
        ) : null}
      </Stack>
    </Box>
  );
};

/** Minimal first-pass control surface, not a live worker-monitoring dashboard. */
export const RemoteWorkersWidgetView = (_props: WidgetViewProps) => {
  const settings = remoteWorkersStore.useSnapshot();
  const urls = getRemoteWorkerUrls(settings.workerUrls);
  const accountId = captureAccountScope().accountId;
  const [showAdvanced, setShowAdvanced] = useState(false);
  const handleAdvancedChange = useCallback((details: { checked: boolean }) => {
    setShowAdvanced(details.checked);
  }, []);
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
        <Switch.Label>Mirror InvokeAI generations</Switch.Label>
      </Switch.Root>
      <Text color="fg.muted" fontSize="xs">
        The primary instance keeps rendering. Each enabled remote receives a variation with its own seed. Results follow
        InvokeAI's selected Gallery or Canvas destination.
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
      <Box borderColor="border.subtle" borderTopWidth="1px" pt="3">
        <Stack gap="2">
          <Text fontWeight="medium" fontSize="sm">
            Worker authentication
          </Text>
          <Text color="fg.muted" fontSize="xs">
            For workers with multi-user mode enabled, save that worker's InvokeAI email and password once. Passwords are
            encrypted using Windows DPAPI on the primary instance and never stored in browser settings or workflows. Use
            HTTPS when connecting across untrusted networks.
          </Text>
          {urls.map((url) => (
            <WorkerAuthRow key={`${accountId}:${url}`} url={url} />
          ))}
        </Stack>
      </Box>
      <Text color="fg.muted" fontSize="xs">
        Gallery results use the board selected when you invoke. Canvas results become staging candidates you can accept.
      </Text>
    </Stack>
  );
};
