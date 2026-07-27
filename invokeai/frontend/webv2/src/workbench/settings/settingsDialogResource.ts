import { createDeferredResource } from '@platform/state/deferredResource';

/**
 * The settings dialog body, loaded on first use.
 *
 * The body reaches into workbench commands, the persistence service, and every
 * settings section, so importing it eagerly would make the Launchpad pay for
 * the whole editor composition before the user has opened a project. It stays
 * behind this resource rather than `React.lazy` because a lazy component cannot
 * be resolved from outside its own first render: warming the module registry
 * still leaves the render suspending, and a suspension costs 300ms of fallback
 * throttle whether or not the chunk is already in memory.
 */
export const settingsDialogResource = createDeferredResource(() => import('./SettingsDialog'));
