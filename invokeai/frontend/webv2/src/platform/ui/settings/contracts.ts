import type { TFunction } from 'i18next';
import type { ComponentType } from 'react';

export type SettingsText = string | ((t: TFunction) => string);
export const resolveSettingsText = (text: SettingsText, t: TFunction): string =>
  typeof text === 'function' ? text(t) : text;

interface SettingBase {
  id: string;
  label: SettingsText;
  description?: SettingsText;
  group?: SettingsText;
  keywords?: string;
  scope: 'preference' | 'project' | 'instance' | 'server' | 'none';
}

export type SettingDefinition = SettingBase &
  (
    | { kind: 'boolean' }
    | { kind: 'select'; options: readonly { label: SettingsText; value: string }[] }
    | { kind: 'number' | 'slider'; min: number; max: number; step?: number }
    | { kind: 'custom' }
  );

export interface SettingsTarget {
  projectId: string;
  instanceId?: string;
}

export interface SettingFieldProps {
  field: SettingDefinition;
  surface: 'quick' | 'dialog';
  target?: SettingsTarget;
}

export interface SettingsContribution {
  id: string;
  label: SettingsText;
  fields: readonly SettingDefinition[];
  /** Ordered subset of field ids. Omitted fields remain available in the dialog. */
  quick?: readonly string[];
  load: () => Promise<{ Field: ComponentType<SettingFieldProps> }>;
}
