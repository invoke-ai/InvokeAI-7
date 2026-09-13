import { createSystem, defaultConfig, defineConfig } from '@chakra-ui/react';

import {
  buttonRecipe,
  colorPickerSlotRecipe,
  comboboxSlotRecipe,
  dataListSlotRecipe,
  dialogSlotRecipe,
  hoverCardSlotRecipe,
  inputRecipe,
  menuSlotRecipe,
  numberInputSlotRecipe,
  popoverSlotRecipe,
  progressCircleSlotRecipe,
  scrollAreaSlotRecipe,
  segmentGroupSlotRecipe,
  selectSlotRecipe,
  skeletonRecipe,
  sliderSlotRecipe,
  tabsSlotRecipe,
  textareaRecipe,
  tooltipSlotRecipe,
} from './recipes';
import { DEFAULT_THEME, DEFAULT_THEME_ID, type NeutralStep, THEMES, type ThemeDefinition } from './themes';

/**
 * Workbench design system.
 *
 * Each theme is one neutral ramp (`neutral.50…950`) plus seeds and four
 * off-ramp neutrals, turned into two token layers:
 *
 *   1. The **ramp** emits as conditional semantic tokens keyed on
 *      `[data-theme=<id>]`. Chakra's base `tokens.colors` hold plain strings, so
 *      anything varying per theme must live in `semanticTokens`.
 *   2. The **semantic contract** (`bg`, `fg.muted`, …) is theme-agnostic and
 *      flips by light/dark only. Light is not a mirror of dark — light panels go
 *      *whiter* than the app background.
 *
 * `ThemeController` sets `data-theme` on `<html>`, so switching is one attribute
 * change with zero re-render. Components reference only semantic tokens.
 * Re-pointing Chakra's `gray` at the ramp makes every built-in component follow
 * the theme without per-component overrides.
 */

const NON_DEFAULT_THEMES = THEMES.filter((theme) => theme.id !== DEFAULT_THEME_ID);

/** `light` -> `themeLight`, `ultradark` -> `themeUltradark`. */
const conditionName = (id: string): string => `theme${id.charAt(0).toUpperCase()}${id.slice(1)}`;

type TokenValue = { value: Record<string, string> };
type Compute = (theme: ThemeDefinition) => string;

/** Build a semantic-token value object: default theme as `base`, the rest as `[data-theme]` conditions. */
const colorToken = (compute: Compute): TokenValue => {
  const value: Record<string, string> = { base: compute(DEFAULT_THEME) };
  for (const theme of NON_DEFAULT_THEMES) {
    value[`_${conditionName(theme.id)}`] = compute(theme);
  }
  return { value };
};

/** Blend `pct`% of one computed color into another — used for derived hover/tint steps. */
const mix = (top: Compute, pct: number, bottom: Compute): TokenValue =>
  colorToken((theme) => `color-mix(in oklab, ${top(theme)} ${pct}%, ${bottom(theme)})`);

const LIGHT_FALLBACK_THEME = THEMES.find((theme) => theme.colorScheme === 'light') ?? DEFAULT_THEME;

/**
 * Like `colorToken`, but additionally shadows Chakra's `_light`/`_dark`
 * class-conditional values. Nested palette tokens (`gray.*`) deep-merge with
 * `defaultConfig` instead of replacing it, so without these keys the default
 * gray values would survive the merge and outrank our zero-specificity `base`
 * value whenever `ThemeController` sets the `.dark`/`.light` class. The explicit
 * `:root[data-theme=…]` conditions still win over both.
 */
const grayToken = (compute: Compute): TokenValue => {
  const token = colorToken(compute);
  token.value._light = compute(LIGHT_FALLBACK_THEME);
  token.value._dark = compute(DEFAULT_THEME);
  return token;
};

/**
 * A token that reads a ramp step, chosen per theme by `colorScheme`. Emitted as
 * per-`[data-theme]` conditions, NOT Chakra's `_light`/`_dark`: the built-in
 * `_light` selector is `:root &, .light &`, and its `:root &` arm matches under
 * EVERY theme — so a mode-flip token leaks its light value into the dark themes.
 * Per-theme conditions sidestep the cascade entirely (this is how the pre-refactor
 * system worked, and why dark themes rendered correctly).
 */
const ref = (step: NeutralStep): string => `{colors.neutral.${step}}`;
const stepRef = (darkStep: NeutralStep, lightStep: NeutralStep): TokenValue =>
  colorToken((theme) => ref(theme.colorScheme === 'light' ? lightStep : darkStep));

/**
 * The high-contrast boost only differs by color scheme, so two conditions
 * cover every theme: ramp-step references resolve per theme on their own.
 * Unrelated to Chakra's built-in `_highContrast` (`forced-colors`); these key
 * off the app preference.
 */
const withHighContrast = (token: TokenValue, darkStep: NeutralStep, lightStep: NeutralStep): TokenValue => {
  token.value._highContrastDark = ref(darkStep);
  token.value._highContrastLight = ref(lightStep);
  return token;
};

/** A ramp-step token with a stronger step pair under high contrast. */
const contrastStepRef = (
  darkStep: NeutralStep,
  lightStep: NeutralStep,
  highDarkStep: NeutralStep,
  highLightStep: NeutralStep
): TokenValue => withHighContrast(stepRef(darkStep, lightStep), highDarkStep, highLightStep);

const STEPS: NeutralStep[] = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950];

/** The default panel surface of a theme — `bg.subtle`'s step. Used as the floor for tints. */
const surface: Compute = (theme) =>
  theme.colorScheme === 'light' ? theme.colors.neutral[50] : theme.colors.neutral[900];

// Seed accessors.
const danger: Compute = (theme) => theme.colors.danger;
const success: Compute = (theme) => theme.colors.success;
const warning: Compute = (theme) => theme.colors.warning;
const brandSolid: Compute = (theme) => theme.colors.brand.solid;

/**
 * Brand as a *foreground* colour rather than a fill.
 *
 * The seed is a bright lime picked to carry on the dark themes' near-black
 * surfaces, where it measures 14.5:1. On the light theme the same value sits at
 * L≈92% against a 99% white panel and measures 1.20:1 — invisible, which is why
 * the Invoke mark all but disappeared there. Darkening it halfway into the text
 * ramp brings it to 4.2:1 on the panel and 4.1:1 on `brand.subtle`: still
 * unmistakably the brand hue, now actually a colour you can put something in.
 *
 * `brand.solid` is untouched — fills keep the bright seed and pair it with
 * `brand.contrast`.
 */
const brandFg: Compute = (theme) =>
  theme.colorScheme === 'light'
    ? `color-mix(in oklab, ${theme.colors.brand.solid} 50%, ${theme.colors.neutral[950]})`
    : theme.colors.brand.solid;
const accentSolid: Compute = (theme) => theme.colors.accent.solid;

/** The neutral ramp, emitted as `neutral.50…neutral.950`, one value per theme. */
const neutralRamp = Object.fromEntries(STEPS.map((step) => [step, colorToken((theme) => theme.colors.neutral[step])]));

/**
 * The semantic-token contract. Backgrounds/foregrounds/borders reference ramp
 * steps (`stepRef`); the four off-ramp neutrals and the status/identity hues read
 * their per-theme seed directly. Where a Chakra built-in name exists we use it
 * verbatim so built-ins inherit the theme for free.
 */
const semanticColors = {
  neutral: neutralRamp,

  // Surface ladder. Light panels are whiter than the app bg, so the light steps
  // are not a mirror of the dark ones.
  bg: stepRef(950, 200),
  'bg.subtle': stepRef(900, 50),
  'bg.muted': stepRef(800, 100),
  'bg.panel': stepRef(800, 100),
  'bg.emphasized': colorToken((theme) => theme.colors.control),
  'bg.inset': colorToken((theme) => theme.colors.inset),
  // Soft status fills for alerts/banners, mixed into the panel surface.
  'bg.error': mix(danger, 14, surface),
  'bg.success': mix(success, 14, surface),
  'bg.warning': mix(warning, 14, surface),

  // Foreground. Muted/subtle text carries the contrast burden: under high
  // contrast they climb toward `fg` while staying a visible rank below it.
  fg: stepRef(50, 950),
  'fg.muted': contrastStepRef(300, 700, 200, 800),
  'fg.subtle': contrastStepRef(400, 500, 300, 700),
  'fg.grid': colorToken((theme) => theme.colors.grid),
  'fg.error': colorToken(danger),
  'fg.success': colorToken(success),
  'fg.warning': colorToken(warning),

  // Borders.
  border: contrastStepRef(600, 300, 300, 500),
  'border.subtle': contrastStepRef(600, 300, 300, 500),
  'border.muted': contrastStepRef(600, 300, 300, 500),
  'border.emphasized': contrastStepRef(500, 400, 200, 600),
  'border.error': colorToken(danger),
  'border.image': colorToken((theme) => (theme.colorScheme === 'light' ? 'oklch(0 0 0 / 0.1)' : 'oklch(1 0 0 / 0.1)')),

  /**
   * Chakra's default `colorPalette` is `gray`; re-pointing its virtual-palette
   * keys at the ramp makes every un-palettized component (ghost buttons, menu
   * items, badges, …) theme-aware with zero props.
   *
   * Palette tokens must stay NESTED — the `colorPalette` virtual-token map is
   * built from the nested structure and ignores flat dotted keys. Because nesting
   * deep-merges with the defaults, every gray key shadows the default
   * `_light`/`_dark` values via `grayToken`.
   */
  gray: {
    contrast: grayToken((theme) =>
      theme.colorScheme === 'light' ? theme.colors.neutral[200] : theme.colors.neutral[950]
    ),
    fg: grayToken((theme) => (theme.colorScheme === 'light' ? theme.colors.neutral[950] : theme.colors.neutral[50])),
    subtle: grayToken((theme) => theme.colors.fill),
    muted: grayToken((theme) => theme.colors.control),
    emphasized: withHighContrast(
      grayToken((theme) => (theme.colorScheme === 'light' ? theme.colors.neutral[400] : theme.colors.neutral[500])),
      300,
      600
    ),
    solid: grayToken((theme) => (theme.colorScheme === 'light' ? theme.colors.neutral[950] : theme.colors.neutral[50])),
    focusRing: grayToken(accentSolid),
    border: withHighContrast(
      grayToken((theme) => (theme.colorScheme === 'light' ? theme.colors.neutral[400] : theme.colors.neutral[500])),
      300,
      600
    ),
    /**
     * Interaction-fill base for the default palette: fg pulled toward the
     * accent, so translucent hovers read in the menus' cool-tinted family
     * instead of a flat gray. Used at low alpha (`gray.hoverTint/10`).
     */
    hoverTint: grayToken(
      (theme) =>
        `color-mix(in oklab, ${theme.colors.accent.solid} 40%, ${
          theme.colorScheme === 'light' ? theme.colors.neutral[950] : theme.colors.neutral[50]
        })`
    ),
  },
  // Palette-tinted interaction fills for the non-default palettes buttons use.
  red: { hoverTint: { value: '{colors.red.fg}' } },
  orange: { hoverTint: { value: '{colors.orange.fg}' } },
  green: { hoverTint: { value: '{colors.green.fg}' } },
  blue: { hoverTint: { value: '{colors.blue.fg}' } },
  /**
   * Invoke identity palette (lime). Authored from two seeds (`solid` + `contrast`),
   * like `accent`; the rest derive. `brand.fg` is the seed on the dark themes and a
   * darkened mix on the light one (see {@link brandFg}), so it is safe to put text
   * and icons in on any theme; `brand.solid` stays the bright fill and wants
   * `brand.contrast` on top of it.
   */
  brand: {
    solid: colorToken(brandSolid),
    contrast: colorToken((theme) => theme.colors.brand.contrast),
    fg: colorToken(brandFg),
    subtle: mix(brandSolid, 16, surface),
    muted: mix(brandSolid, 26, surface),
    emphasized: mix(brandSolid, 36, surface),
    focusRing: colorToken(accentSolid),
    border: colorToken(brandSolid),
    hoverTint: colorToken(brandFg),
  },
  /** Selection / focus palette (blue). Use via `accent.solid` or `colorPalette="accent"`. */
  accent: {
    solid: colorToken(accentSolid),
    contrast: colorToken((theme) => theme.colors.accent.contrast),
    fg: colorToken(accentSolid),
    subtle: mix(accentSolid, 16, surface),
    muted: mix(accentSolid, 26, surface),
    emphasized: mix(accentSolid, 36, surface),
    focusRing: colorToken(accentSolid),
    border: colorToken(accentSolid),
    hoverTint: colorToken(accentSolid),
  },
};

// `:root` raises specificity above the `.dark`/`.light` colorScheme classes so
// an explicit theme always beats the class-conditional fallback values.
const themeConditions = Object.fromEntries(
  NON_DEFAULT_THEMES.map((theme) => [conditionName(theme.id), `:root[data-theme=${theme.id}]`])
);
// The attribute pair outranks the plain `[data-theme]` conditions; light
// themes are enumerated so a future light theme cannot fall into the dark arm.
const lightThemeSelectors = THEMES.filter((theme) => theme.colorScheme === 'light')
  .map((theme) => `[data-theme=${theme.id}]`)
  .join(', ');
const highContrastConditions = {
  highContrastDark: `:root[data-high-contrast=true]:not(${lightThemeSelectors})`,
  highContrastLight: `:root[data-high-contrast=true]:is(${lightThemeSelectors})`,
};

const motionDurationToken = (base: string): TokenValue => ({ value: { base, _reduceMotion: '1ms' } });
const motionAnimationToken = (base: string): TokenValue => ({ value: { base, _reduceMotion: 'none' } });

const config = defineConfig({
  conditions: { ...themeConditions, ...highContrastConditions, reduceMotion: ':root[data-reduce-motion=true]' },
  globalCss: {
    'html, body, #root': {
      height: '100%',
    },
    body: {
      bg: 'bg',
      color: 'fg',
      fontFamily: 'body',
      margin: 0,
      overflow: 'hidden',
    },
    // Interactive elements keep the default arrow even over their text —
    // without this, non-button rows (picker options, menu items) compute
    // `auto` and show the I-beam. Recipes still override (e.g. not-allowed).
    // Attribute values stay unquoted: serialized markup assertions (SamOptions)
    // grep for the quoted forms. No `[role=combobox]` — zag puts that role on
    // type-able inputs, which must keep the I-beam.
    'button, [role=button], [role=menuitem], [role=menuitemcheckbox], [role=menuitemradio], [role=option], [role=tab], [role=radio], [role=checkbox], [role=switch]':
      {
        cursor: 'default',
      },
    // While a gallery-item drag is in flight (body flag set by
    // GalleryDragCursor) the closed-hand cursor applies everywhere: without
    // the descendant rule, every element that sets its own cursor (buttons,
    // textareas, grab handles) would flicker it back mid-drag.
    'body[data-gallery-drag], body[data-gallery-drag] *': {
      cursor: 'grabbing !important',
    },
    ':root': {
      '--wb-motion-duration-fast': '0.12s',
      '--wb-motion-duration-medium': '0.15s',
      '--wb-motion-duration-slow': '0.2s',
      '--wb-motion-animation-iteration-count': 'infinite',
    },
    // Keep durations non-zero: Ark presence waits for animation lifecycle events.
    // Chakra recipe motion is covered by conditional duration/animation tokens below.
    ':root[data-reduce-motion="true"]': {
      '--wb-motion-duration-fast': '1ms',
      '--wb-motion-duration-medium': '1ms',
      '--wb-motion-duration-slow': '1ms',
      '--wb-motion-animation-iteration-count': '1',
      scrollBehavior: 'auto !important',
    },
    // `backgroundImage` too: the shine gradient frozen mid-sweep reads as a
    // smudge, so reduce-motion falls back to the flat fill.
    ':root[data-reduce-motion="true"] .chakra-skeleton': {
      animation: 'none !important',
      backgroundImage: 'none !important',
    },
    // A loading spinner is essential status, not decoration — frozen, its arc
    // reads as a broken icon. It slows to a crawl instead of stopping; WCAG
    // 2.3.3 targets non-essential motion only. (Chakra's indeterminate
    // progress circle already behaves this way: its raw `spin 2s` shorthand
    // bypasses the animation tokens the reduce-motion condition nulls out.)
    ':root[data-reduce-motion="true"] .chakra-spinner': {
      animation: 'spin 2s linear infinite !important',
    },
  },
  theme: {
    tokens: {
      // Pro-app convention: controls keep the default arrow cursor; pointer is
      // reserved for links. Overrides Chakra's `button`/`switch` pointer tokens.
      cursor: {
        button: { value: 'default' },
        switch: { value: 'default' },
      },
      radii: {
        // The shared corner for interactive controls — buttons and the
        // segment-tab pills meet between Chakra's l2 (4px) and md (6px).
        control: { value: '0.3125rem' },
      },
      fonts: {
        body: {
          value: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        },
        heading: {
          value: "Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif",
        },
      },
    },
    semanticTokens: {
      animations: {
        bounce: motionAnimationToken('bounce 1s infinite'),
        ping: motionAnimationToken('ping 1s cubic-bezier(0, 0, 0.2, 1) infinite'),
        pulse: motionAnimationToken('pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite'),
        spin: motionAnimationToken('spin 1s linear infinite'),
      },
      colors: semanticColors,
      durations: {
        fastest: motionDurationToken('50ms'),
        faster: motionDurationToken('100ms'),
        fast: motionDurationToken('150ms'),
        moderate: motionDurationToken('200ms'),
        slow: motionDurationToken('300ms'),
        slower: motionDurationToken('400ms'),
        slowest: motionDurationToken('500ms'),
      },
    },
    // Chrome-level overrides for Chakra's built-in components, so popover and
    // dialog surfaces are consistent everywhere without per-instance props.
    recipes: {
      button: buttonRecipe,
      input: inputRecipe,
      skeleton: skeletonRecipe,
      textarea: textareaRecipe,
    },
    slotRecipes: {
      colorPicker: colorPickerSlotRecipe,
      combobox: comboboxSlotRecipe,
      dataList: dataListSlotRecipe,
      dialog: dialogSlotRecipe,
      hoverCard: hoverCardSlotRecipe,
      menu: menuSlotRecipe,
      numberInput: numberInputSlotRecipe,
      popover: popoverSlotRecipe,
      progressCircle: progressCircleSlotRecipe,
      scrollArea: scrollAreaSlotRecipe,
      segmentGroup: segmentGroupSlotRecipe,
      select: selectSlotRecipe,
      slider: sliderSlotRecipe,
      tabs: tabsSlotRecipe,
      tooltip: tooltipSlotRecipe,
    },
  },
});

export const system = createSystem(defaultConfig, config);

/** Theme metadata re-exported so UI can import a single module. */
export { THEMES, THEMES_BY_ID, DEFAULT_THEME, DEFAULT_THEME_ID, previewSwatches } from './themes';
export type { ThemeColors, ThemeDefinition, NeutralStep } from './themes';
