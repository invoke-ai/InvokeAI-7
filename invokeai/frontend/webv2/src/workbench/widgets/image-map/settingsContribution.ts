import type { SettingsContribution } from '@platform/ui/settings/contracts';

export const imageMapSettingsContribution: SettingsContribution = {
  id: 'imageMap',
  label: (t) => t('widgets.labels.imageMap'),
  fields: [
    {
      id: 'showClusterLabels',
      kind: 'boolean',
      label: (t) => t('settingsDialog.fields.showClusterLabels'),
      scope: 'instance',
      keywords: 'tags text display',
    },
    {
      id: 'clickSelectsCluster',
      kind: 'boolean',
      label: (t) => t('settingsDialog.fields.clickSelectsCluster'),
      scope: 'instance',
      keywords: 'click gallery selection',
    },
  ],
  load: () => import('./settingsBindings'),
};
