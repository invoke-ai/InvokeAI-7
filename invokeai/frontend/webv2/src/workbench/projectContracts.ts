import type { ProjectGraphState } from '@features/workflow/contracts';
import type { BackendConnectionStatus } from '@platform/transport/types';

import type { CanvasStateContractV3 } from './canvas-engine/api';
import type { CanvasLoadRefusal } from './canvasLoadContracts';
import type { GraphContract } from './graphContracts';
import type { InvocationControllerState } from './invocationContracts';
import type {
  FloatingWidgetState,
  LayoutPreset,
  LayoutPresetId,
  LayoutPresetMetadataOverrides,
  LayoutPresetOverrides,
  LayoutPresetRouteOverrides,
  ProjectLayoutState,
  WidgetRegion,
  WidgetRegionState,
} from './layoutContracts';
import type { ProjectEvent } from './projectEventContracts';
import type { WorkbenchQueueState } from './queueHistoryContracts';
import type { ProjectSettings } from './settings/contracts';
import type { WidgetFailure, WidgetInstanceContract, WidgetInstanceId, WidgetTypeId } from './widgetContracts';

export type { ProjectEvent, ProjectEventType } from './projectEventContracts';

export interface Project {
  id: string;
  name: string;
  settings: ProjectSettings;
  layout: ProjectLayoutState;
  invocation: InvocationControllerState;
  /** The one active project graph: an editable workflow document, compiled to a `GraphContract` at invoke time. */
  projectGraph: ProjectGraphState;
  widgetInstances: Record<WidgetInstanceId, WidgetInstanceContract>;
  widgetRegions: Record<WidgetRegion, WidgetRegionState>;
  /**
   * Widget instances detached into floating windows. Optional and additive:
   * projects persisted before this field existed hydrate with no floating
   * windows. A floated instance is removed from its region's instanceIds
   * while it floats.
   */
  floatingWidgets?: Record<WidgetInstanceId, FloatingWidgetState>;
  widgetGraphs: Partial<Record<WidgetTypeId, GraphContract>>;
  canvas: CanvasStateContractV3;
  promptHistory: PromptHistoryItem[];
  undoRedo: UndoRedoHistory;
  queue: WorkbenchQueueState;
  events: ProjectEvent[];
}

/** A persisted project the canvas version gate refused. `raw` is the untouched document, kept for recovery. */
export interface ProjectDocumentLoadRefusal {
  raw: unknown;
  scope: 'project-document';
  status: 'unsupported-version';
  version: number;
}

interface RefusedWorkbenchProjectBase {
  projectId: string;
  projectName: string;
  raw: unknown;
}

export type RefusedWorkbenchProject = RefusedWorkbenchProjectBase &
  (
    | { refusal: CanvasLoadRefusal; source: 'canvas'; queueItem?: never }
    | { refusal: ProjectDocumentLoadRefusal; source: 'project-document'; queueItem?: never }
  );

export type ProjectLoadResult =
  | { status: 'loaded'; project: Project }
  | { status: 'refused'; refused: RefusedWorkbenchProject }
  | { status: 'unavailable' };

export interface WorkbenchState {
  projects: Project[];
  activeProjectId: string;
  backendConnection: BackendConnectionState;
  notifications: WorkbenchNotification[];
  autosave: AutosaveState;
  account: AccountState;
  widgetFailures: WidgetFailure[];
}

export interface BackendConnectionState {
  status: BackendConnectionStatus;
  error?: string;
  lastConnectedAt?: string;
  lastDisconnectedAt?: string;
}

export type WorkbenchNotificationKind = 'error' | 'success' | 'info';

/** Machine categories for toast policy. Absent category = always toast. */
export type WorkbenchNotificationCategory = 'enqueue';

export interface WorkbenchNotification {
  id: string;
  kind: WorkbenchNotificationKind;
  title: string;
  message?: string;
  createdAt: string;
  projectId?: string;
  isRead: boolean;
  /** Machine category for toast policy; absent = always toast. */
  category?: WorkbenchNotificationCategory;
  /** Coalesced repeat count (see addNotification); absent = 1. */
  occurrenceCount?: number;
}

export interface PromptHistoryItem {
  positivePrompt: string;
  negativePrompt: string | null;
}

export interface UndoRedoEntry {
  id: string;
  createdAt: string;
  label: string;
  project: ProjectUndoSnapshot;
}

/**
 * Project-level undo snapshot. Deliberately excludes `canvas`: the canvas
 * rendering engine owns its own pixel-patch history, so project undo/redo
 * passes the live `project.canvas` through untouched (see `restoreUndoSnapshot`).
 */
export interface ProjectUndoSnapshot {
  layout: ProjectLayoutState;
  invocation: InvocationControllerState;
  projectGraph: ProjectGraphState;
  widgetInstances: Record<WidgetInstanceId, WidgetInstanceContract>;
  widgetRegions: Record<WidgetRegion, WidgetRegionState>;
  /** Captured with widgetRegions: regions and floating windows are one placement fact. */
  floatingWidgets?: Record<WidgetInstanceId, FloatingWidgetState>;
  widgetGraphs: Partial<Record<WidgetTypeId, GraphContract>>;
}

export interface UndoRedoHistory {
  past: UndoRedoEntry[];
  future: UndoRedoEntry[];
}

export interface AutosaveState {
  status: 'idle' | 'saving' | 'saved' | 'error';
  lastSavedAt?: string;
  error?: string;
}

export interface AccountState {
  activeLayoutPresetId: LayoutPresetId;
  customLayoutPresets?: LayoutPreset[];
  /** One account-wide order shared by every layout-preset surface. */
  layoutPresetOrder?: LayoutPresetId[];
  /** Saved name and icon edits for built-in presets. */
  layoutPresetMetadataOverrides?: LayoutPresetMetadataOverrides;
  /** Saved edits to a built-in preset's arrangement; see {@link LayoutPresetOverrides}. */
  layoutPresetOverrides?: LayoutPresetOverrides;
  /** Saved edits to built-in preset routes, kept separate from spatial layout drift. */
  layoutPresetRouteOverrides?: LayoutPresetRouteOverrides;
}
