import type { FieldType, XYPosition } from '@features/workflow/contracts';

import { registerAccountOwnedResource } from '@platform/state/accountLifecycle';
import { createExternalStore } from '@platform/state/externalStore';

export type AddNodeConnectionFilter =
  | {
      kind: 'source';
      sourceHandle: string;
      sourceNodeId: string;
      sourceType: FieldType | null;
    }
  | {
      kind: 'target';
      targetHandle: string;
      targetNodeId: string;
      targetType: FieldType | null;
    };

/** Bridge transient menu actions to always-mounted workflow dialogs and file input through session UI state. */

export interface WorkflowUiSnapshot {
  addNodeConnection: AddNodeConnectionFilter | null;
  addNodePosition: XYPosition | null;
  /** Nodes whose latest-output preview is folded away. Session-lived, like the previews themselves. */
  collapsedPreviewNodeIds: ReadonlySet<string>;
  isAddNodeOpen: boolean;
  isLibraryOpen: boolean;
  isNewWorkflowConfirmOpen: boolean;
  /** Bumped to ask the dialog host to open the JSON file picker. */
  importRequestCount: number;
  /** A workflow a shell surface (command palette, an image's context menu) asked to load; consumed by the widget chrome. */
  pendingWorkflowLoad: WorkflowLoadRequest | null;
}

export type WorkflowLoadSource =
  | { kind: 'library'; workflowId: string }
  /** An already-fetched workflow document (an image's embedded workflow); `label` names the undo step. */
  | { kind: 'document'; label: string; raw: unknown };

export interface WorkflowLoadRequest {
  requestId: number;
  source: WorkflowLoadSource;
}

let nextWorkflowLoadRequestId = 0;

const INITIAL_WORKFLOW_UI_SNAPSHOT: WorkflowUiSnapshot = {
  addNodeConnection: null,
  addNodePosition: null,
  collapsedPreviewNodeIds: new Set(),
  importRequestCount: 0,
  isAddNodeOpen: false,
  isLibraryOpen: false,
  isNewWorkflowConfirmOpen: false,
  pendingWorkflowLoad: null,
};

export const workflowUiStore = createExternalStore<WorkflowUiSnapshot>(INITIAL_WORKFLOW_UI_SNAPSHOT);

registerAccountOwnedResource({
  clear: () => {
    workflowUiStore.setSnapshot(INITIAL_WORKFLOW_UI_SNAPSHOT);
  },
  name: 'workflow-ui',
});

export const setWorkflowLibraryOpen = (isOpen: boolean): void => {
  workflowUiStore.patchSnapshot({ isLibraryOpen: isOpen });
};

export const setAddNodeOpen = (
  isOpen: boolean,
  position: XYPosition | null = null,
  connection: AddNodeConnectionFilter | null = null
): void => {
  workflowUiStore.patchSnapshot({
    addNodeConnection: isOpen ? connection : null,
    addNodePosition: isOpen ? position : null,
    isAddNodeOpen: isOpen,
  });
};

export const setNewWorkflowConfirmOpen = (isOpen: boolean): void => {
  workflowUiStore.patchSnapshot({ isNewWorkflowConfirmOpen: isOpen });
};

const requestWorkflowLoad = (source: WorkflowLoadSource): void => {
  nextWorkflowLoadRequestId += 1;
  workflowUiStore.patchSnapshot({ pendingWorkflowLoad: { requestId: nextWorkflowLoadRequestId, source } });
};

export const requestLibraryWorkflowLoad = (workflowId: string): void =>
  requestWorkflowLoad({ kind: 'library', workflowId });

export const requestWorkflowDocumentLoad = (raw: unknown, label: string): void =>
  requestWorkflowLoad({ kind: 'document', label, raw });

export const clearPendingWorkflowLoad = (requestId: number): void => {
  if (workflowUiStore.getSnapshot().pendingWorkflowLoad?.requestId === requestId) {
    workflowUiStore.patchSnapshot({ pendingWorkflowLoad: null });
  }
};

export const setNodePreviewCollapsed = (nodeId: string, collapsed: boolean): void => {
  const collapsedPreviewNodeIds = new Set(workflowUiStore.getSnapshot().collapsedPreviewNodeIds);

  if (collapsed) {
    collapsedPreviewNodeIds.add(nodeId);
  } else {
    collapsedPreviewNodeIds.delete(nodeId);
  }

  workflowUiStore.patchSnapshot({ collapsedPreviewNodeIds });
};

export const requestWorkflowImport = (): void => {
  workflowUiStore.patchSnapshot({ importRequestCount: workflowUiStore.getSnapshot().importRequestCount + 1 });
};
