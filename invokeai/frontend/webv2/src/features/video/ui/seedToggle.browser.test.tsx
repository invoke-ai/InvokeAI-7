import { ChakraProvider, NumberInput, Switch } from '@chakra-ui/react';
import { Field } from '@platform/ui/Field';
import { system } from '@theme/system';
import { act, useId, useMemo } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';

/**
 * The seed row of the Video and Upscale panels puts three controls -- a seed
 * NumberInput, a shuffle button and a randomize Switch -- inside ONE `Field`.
 * Chakra's `Field.Root` hands its single `ids.control` to every control it
 * contains, so without an id of its own the switch's hidden input collides
 * with the seed input and the `<label>` that `Switch.Root` renders resolves to
 * the seed field instead. Clicking the toggle then just moved focus.
 */
let container: HTMLDivElement;
let root: Root;

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const SeedRow = ({ onCheckedChange }: { onCheckedChange: (details: { checked: boolean }) => void }) => {
  const seedSwitchId = useId();
  const seedSwitchIds = useMemo(() => ({ hiddenInput: `${seedSwitchId}-randomize-seed` }), [seedSwitchId]);

  return (
    <Field hint="seed" label="Seed">
      <NumberInput.Root size="xs" value="42">
        <NumberInput.Input aria-label="Seed" />
      </NumberInput.Root>
      <Switch.Root checked={false} ids={seedSwitchIds} size="sm" onCheckedChange={onCheckedChange}>
        <Switch.HiddenInput data-testid="switch-input" />
        <Switch.Control data-testid="switch-control">
          <Switch.Thumb />
        </Switch.Control>
        <Switch.Label>Randomize seed</Switch.Label>
      </Switch.Root>
    </Field>
  );
};

const render = (onCheckedChange: (details: { checked: boolean }) => void) =>
  act(() => {
    root.render(
      <ChakraProvider value={system}>
        <SeedRow onCheckedChange={onCheckedChange} />
      </ChakraProvider>
    );
  });

describe('seed row randomize switch', () => {
  it('does not share the Field control id with the seed input', async () => {
    await render(vi.fn());

    const seed = container.querySelector<HTMLInputElement>('input[aria-label="Seed"]')!;
    const toggle = container.querySelector<HTMLInputElement>('[data-testid="switch-input"]')!;

    expect(toggle.id).not.toBe('');
    expect(toggle.id).not.toBe(seed.id);
    // The label Switch.Root renders must point at the switch, not the seed field.
    expect(toggle.closest('label')?.getAttribute('for')).toBe(toggle.id);
  });

  it('toggles when the control is clicked, leaving the seed input unfocused', async () => {
    const onCheckedChange = vi.fn();

    await render(onCheckedChange);
    const seed = container.querySelector<HTMLInputElement>('input[aria-label="Seed"]')!;

    await userEvent.click(container.querySelector('[data-testid="switch-control"]')!);

    expect(onCheckedChange).toHaveBeenCalledWith(expect.objectContaining({ checked: true }));
    expect(document.activeElement).not.toBe(seed);
  });

  it('toggles when the label text is clicked', async () => {
    const onCheckedChange = vi.fn();

    await render(onCheckedChange);

    const label = [...container.querySelectorAll('*')].find(
      (node) => node.textContent === 'Randomize seed' && node.children.length === 0
    )!;

    await userEvent.click(label);

    expect(onCheckedChange).toHaveBeenCalledWith(expect.objectContaining({ checked: true }));
  });
});
