import type { SettingDefinition, SettingsContribution, SettingsText } from '@platform/ui/settings/contracts';
import type { DeferredResource } from '@workbench/deferredResource';
import type { WidgetIconComponent, WidgetManifest } from '@workbench/widgetContracts';
import type { TFunction } from 'i18next';

import { resolveSettingsText } from '@platform/ui/settings/contracts';
import { createDeferredResource } from '@workbench/deferredResource';
import { firstPartyWidgetManifests } from '@workbench/widgets/manifests';
import {
  Code2Icon,
  DatabaseIcon,
  FolderIcon,
  InfoIcon,
  KeyboardIcon,
  PaletteIcon,
  ServerIcon,
  SlidersHorizontalIcon,
} from 'lucide-react';

import { applicationSettingsContributions } from './applicationContributions';

export interface SettingsEntry {
  field: SettingDefinition;
  resource: DeferredResource<Awaited<ReturnType<SettingsContribution['load']>>>;
}
export interface SettingsSection {
  id: string;
  label: SettingsText;
  group: 'application' | 'project' | 'widgets' | 'system';
  icon: WidgetIconComponent;
  widgetId?: string;
  entries: readonly SettingsEntry[];
}

const sectionPresentation = {
  appearance: { group: 'application', icon: PaletteIcon },
  behavior: { group: 'application', icon: SlidersHorizontalIcon },
  hotkeys: { group: 'application', icon: KeyboardIcon },
  project: { group: 'project', icon: FolderIcon },
  developer: { group: 'system', icon: Code2Icon },
  server: { group: 'system', icon: ServerIcon },
  workspace: { group: 'system', icon: DatabaseIcon },
  about: { group: 'system', icon: InfoIcon },
} as const;
const groupOrder = ['application', 'project', 'widgets', 'system'];

/** Pure composition and validation; constructing a catalog never invokes a loader. */
export const buildSettingsCatalog = (
  applications: readonly SettingsContribution[],
  widgets: readonly WidgetManifest[]
): SettingsSection[] => {
  const sections = new Map<string, SettingsSection>();
  const add = (contribution: SettingsContribution, widget?: WidgetManifest) => {
    const existing = sections.get(contribution.id);
    const ids = new Set(existing?.entries.map((entry) => entry.field.id));
    const localIds = new Set(contribution.fields.map((field) => field.id));
    for (const id of contribution.quick ?? []) {
      if (!localIds.has(id)) {
        throw new Error(`Unknown quick setting ${contribution.id}.${id}`);
      }
    }
    const resource = createDeferredResource(contribution.load);
    const entries = contribution.fields.map((field) => {
      if (!field.id || ids.has(field.id)) {
        throw new Error(`Duplicate or empty setting ${contribution.id}.${field.id}`);
      }
      ids.add(field.id);
      return { field, resource };
    });
    const presentation = sectionPresentation[contribution.id as keyof typeof sectionPresentation];
    sections.set(contribution.id, {
      id: contribution.id,
      label: widget?.settings?.label ?? existing?.label ?? contribution.label,
      group: widget ? 'widgets' : (existing?.group ?? presentation?.group ?? 'widgets'),
      icon: widget?.icon ?? existing?.icon ?? presentation?.icon ?? SlidersHorizontalIcon,
      widgetId: widget?.id ?? existing?.widgetId,
      entries: [...(existing?.entries ?? []), ...entries],
    });
  };
  for (const widget of widgets) {
    if (widget.settings) {
      add(widget.settings, widget);
    }
  }
  for (const contribution of applications) {
    add(contribution);
  }
  return [...sections.values()].sort(
    (a, b) =>
      groupOrder.indexOf(a.group) - groupOrder.indexOf(b.group) ||
      (a.group === 'widgets' ? a.id.localeCompare(b.id) : 0)
  );
};

export const settingsCatalog = buildSettingsCatalog(applicationSettingsContributions, firstPartyWidgetManifests);

const normalize = (value: string): string => value.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase();
export const searchSettings = (
  sections: readonly SettingsSection[],
  query: string,
  t: TFunction
): SettingsSection[] => {
  const words = normalize(query).trim().split(/\s+/).filter(Boolean);
  if (!words.length) {
    return [...sections];
  }
  return sections.flatMap((section) => {
    const entries = section.entries.filter(({ field }) => {
      const text = normalize(
        [
          resolveSettingsText(section.label, t),
          resolveSettingsText(field.label, t),
          field.description ? resolveSettingsText(field.description, t) : '',
          field.group ? resolveSettingsText(field.group, t) : '',
          field.keywords ?? '',
          field.kind === 'select' ? field.options.map((option) => resolveSettingsText(option.label, t)).join(' ') : '',
        ].join(' ')
      );
      return words.every((word) => text.includes(word));
    });
    return entries.length ? [{ ...section, entries }] : [];
  });
};
