import type * as settingsStoreModule from '@workbench/settings/store';

import { ChakraProvider } from '@chakra-ui/react';
import { system } from '@theme/system';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';

const testPreferences = vi.hoisted(() => ({ customHotkeys: {} as Record<string, string[]> }));
const useWorkbenchPreferencesSpy = vi.hoisted(() => vi.fn(() => testPreferences));

vi.mock('@workbench/settings/store', async (importOriginal) => ({
  ...(await importOriginal<typeof settingsStoreModule>()),
  useWorkbenchPreferenceSelector: <Selected,>(selector: (preferences: typeof testPreferences) => Selected): Selected =>
    selector(testPreferences),
  useWorkbenchPreferences: useWorkbenchPreferencesSpy,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { hotkey?: string }) =>
      key === 'commandPalette.buttonTooltip'
        ? `Command palette (${options?.hotkey ?? ''})`
        : key === 'commandPalette.buttonLabel'
          ? 'Command palette'
          : key,
  }),
}));

vi.mock('./LaunchpadCommandPaletteDialog', () => ({
  LaunchpadCommandPaletteDialog: () => <div data-testid="launchpad-palette" />,
}));

import { LaunchpadCommandPalette } from './LaunchpadCommandPalette';
import { PaletteButton } from './PaletteButton';
import { closeCommandPalette, useIsCommandPaletteOpen } from './paletteStore';

let host: HTMLDivElement | null = null;
let root: Root | null = null;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const OpenState = () => <output data-testid="palette-state">{useIsCommandPaletteOpen() ? 'open' : 'closed'}</output>;

const renderLaunchpad = async (): Promise<void> => {
  await act(() =>
    root?.render(
      <>
        <input aria-label="Editable target" />
        <LaunchpadCommandPalette />
        <OpenState />
      </>
    )
  );
};

const press = async ({ altKey = false, code, ctrlKey = false, key }: KeyboardEventInit): Promise<void> => {
  const target = document.querySelector<HTMLInputElement>('[aria-label="Editable target"]') ?? window;

  await act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { altKey, bubbles: true, cancelable: true, code, ctrlKey, key }));
  });
};

const readPaletteState = (): string | null | undefined =>
  document.querySelector('[data-testid="palette-state"]')?.textContent;

// Opening waits for the palette's dialog module, so the first open of a session
// lands a tick or two after the keypress. Later ones do not — see the
// synchronous case below, which is the property that keeps the fallback
// throttle off the open path.
const expectPaletteState = async (state: 'closed' | 'open'): Promise<void> => {
  await vi.waitFor(() => {
    expect(readPaletteState()).toBe(state);
  });
};

beforeEach(() => {
  testPreferences.customHotkeys = {};
  useWorkbenchPreferencesSpy.mockClear();
  closeCommandPalette();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(() => {
    closeCommandPalette();
    root?.unmount();
  });
  host?.remove();
  host = null;
  root = null;
});

describe('Launchpad command-palette hotkeys', () => {
  it('opens and closes from the default Mod+K binding, including from editable targets', async () => {
    await renderLaunchpad();
    document.querySelector<HTMLInputElement>('[aria-label="Editable target"]')?.focus();

    await press({ code: 'KeyK', ctrlKey: true, key: 'k' });
    await expectPaletteState('open');

    await press({ code: 'KeyK', ctrlKey: true, key: 'k' });
    await expectPaletteState('closed');
  });

  it('opens in the same tick once the dialog module is loaded', async () => {
    await renderLaunchpad();

    await press({ code: 'KeyK', ctrlKey: true, key: 'k' });
    await expectPaletteState('open');
    await act(() => closeCommandPalette());

    // With the module in hand there is nothing left to wait for, and waiting
    // anyway is what would put a suspension — and React's 300ms fallback
    // throttle — back on the open path.
    await press({ code: 'KeyK', ctrlKey: true, key: 'k' });
    expect(readPaletteState()).toBe('open');
  });

  it('replaces the default binding and installs every custom binding', async () => {
    testPreferences.customHotkeys = { 'app.openCommandPalette': ['alt+p', 'alt+o'] };
    await renderLaunchpad();

    await press({ code: 'KeyK', ctrlKey: true, key: 'k' });
    await expectPaletteState('closed');

    await press({ altKey: true, code: 'KeyP', key: 'p' });
    await expectPaletteState('open');
    await act(() => closeCommandPalette());

    await press({ altKey: true, code: 'KeyO', key: 'o' });
    await expectPaletteState('open');
  });

  it('installs no listener when the command is unbound', async () => {
    testPreferences.customHotkeys = { 'app.openCommandPalette': [] };
    await renderLaunchpad();

    await press({ code: 'KeyK', ctrlKey: true, key: 'k' });
    await expectPaletteState('closed');
  });

  it('subscribes to full preferences only while the palette is open', async () => {
    await renderLaunchpad();
    await expectPaletteState('closed');
    expect(useWorkbenchPreferencesSpy).not.toHaveBeenCalled();

    await press({ code: 'KeyK', ctrlKey: true, key: 'k' });
    await expectPaletteState('open');
    expect(useWorkbenchPreferencesSpy).toHaveBeenCalled();
  });

  it('replaces listeners when preferences change without remounting the Launchpad host', async () => {
    testPreferences.customHotkeys = { 'app.openCommandPalette': ['alt+p'] };
    await renderLaunchpad();

    testPreferences.customHotkeys = { 'app.openCommandPalette': ['alt+o'] };
    await renderLaunchpad();

    await press({ altKey: true, code: 'KeyP', key: 'p' });
    await expectPaletteState('closed');

    await press({ altKey: true, code: 'KeyO', key: 'o' });
    await expectPaletteState('open');
  });
});

describe('PaletteButton hotkey tooltip', () => {
  const renderButton = async (): Promise<HTMLButtonElement> => {
    await act(() =>
      root?.render(
        <ChakraProvider value={system}>
          <PaletteButton />
        </ChakraProvider>
      )
    );

    const button = document.querySelector<HTMLButtonElement>('button[aria-label="Command palette"]');
    expect(button).not.toBeNull();
    return button!;
  };

  it('displays the first effective custom binding', async () => {
    testPreferences.customHotkeys = { 'app.openCommandPalette': ['alt+p', 'alt+o'] };
    const button = await renderButton();

    await act(async () => {
      await userEvent.hover(button);
      await vi.waitFor(() => expect(document.body.textContent).toContain('Command palette (alt+p)'));
    });
  });

  it('falls back to the plain label when the command is unbound', async () => {
    testPreferences.customHotkeys = { 'app.openCommandPalette': [] };
    const button = await renderButton();

    await act(async () => {
      await userEvent.hover(button);
      await vi.waitFor(() => expect(document.body.textContent).toContain('Command palette'));
    });
    expect(document.body.textContent).not.toContain('Command palette (');
  });
});
