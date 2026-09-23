import type { ProjectGraphState } from '@features/workflow/core/types';

import {
  createLibraryWorkflow,
  invalidateWorkflowLibraryCache,
  updateLibraryWorkflow,
} from '@features/workflow/queries';
import { useProjectGraphCommands } from '@features/workflow/ui/useProjectGraphCommands';
import {
  useWorkflowNotifications,
  useWorkflowProjectSelector,
  useWorkflowUi,
} from '@features/workflow/ui/WorkflowUiContext';
import { hasMultipleWorkflowReturnNodes, serializeWorkflowJson } from '@features/workflow/utility';
import {
  assertAccountScopeCurrent,
  captureAccountScope,
  isAccountScopeCurrent,
} from '@platform/state/accountLifecycle';
import { getApiErrorMessage } from '@platform/transport/http';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import { markLibraryGraphSynced } from './librarySyncBridge';
import { setWorkflowLibrarySyncStatus } from './workflowLibrarySyncStore';

/**
 * Save active graphs with a matching autosave baseline; arbitrary preview documents can be saved separately as new
 * records.
 */
export const useSaveWorkflowToLibrary = (): {
  saveDocumentAsNew: (document: ProjectGraphState) => Promise<string | null>;
  saveToLibrary: () => Promise<string | null>;
} => {
  const projectGraph = useWorkflowProjectSelector((project) => project.projectGraph);
  const { project: projectStore } = useWorkflowUi();
  const { bindLibraryWorkflow } = useProjectGraphCommands();
  const notify = useWorkflowNotifications();
  const { t } = useTranslation();

  const saveToLibrary = useCallback(async (): Promise<string | null> => {
    const owner = captureAccountScope();

    try {
      if (hasMultipleWorkflowReturnNodes(projectGraph)) {
        notify.error(t('workflowLibrary.saveFailed'), t('workflowLibrary.multipleWorkflowReturnNodes'));
        return null;
      }

      const serialized = serializeWorkflowJson(projectGraph);
      let workflowId: string;
      let syncedSerialized = serialized;

      const name = projectGraph.name || t('workflowLibrary.untitled');

      if (projectGraph.libraryWorkflowId) {
        workflowId = projectGraph.libraryWorkflowId;
        await updateLibraryWorkflow(workflowId, serialized, owner.signal);

        assertAccountScopeCurrent(owner);
        notify.success(t('workflowLibrary.saved'), t('workflowLibrary.savedUpdatedBody', { name }));
      } else {
        workflowId = await createLibraryWorkflow(serialized, owner.signal);

        assertAccountScopeCurrent(owner);
        bindLibraryWorkflow(workflowId);
        notify.success(t('workflowLibrary.saved'), t('workflowLibrary.savedCreatedBody', { name }));

        // Serialize the synchronous post-bind snapshot so the baseline includes its new library ID and cannot
        // trigger an echo save.
        syncedSerialized = serializeWorkflowJson(projectStore.getSnapshot().projectGraph);
      }

      markLibraryGraphSynced(syncedSerialized);
      setWorkflowLibrarySyncStatus('saved');
      invalidateWorkflowLibraryCache(workflowId);

      return workflowId;
    } catch (error) {
      if (!isAccountScopeCurrent(owner)) {
        return null;
      }

      notify.error(t('workflowLibrary.saveFailed'), getApiErrorMessage(error, t('common.unknownError')));
      return null;
    }
  }, [bindLibraryWorkflow, notify, projectGraph, projectStore, t]);

  // Save arbitrary documents as new entries without binding the active project or updating its autosave baseline.
  const saveDocumentAsNew = useCallback(
    async (document: ProjectGraphState): Promise<string | null> => {
      const owner = captureAccountScope();

      try {
        if (hasMultipleWorkflowReturnNodes(document)) {
          notify.error(t('workflowLibrary.saveFailed'), t('workflowLibrary.multipleWorkflowReturnNodes'));
          return null;
        }

        const serialized = serializeWorkflowJson(document);
        const workflowId = await createLibraryWorkflow(serialized, owner.signal);

        assertAccountScopeCurrent(owner);
        invalidateWorkflowLibraryCache(workflowId);

        return workflowId;
      } catch (error) {
        if (!isAccountScopeCurrent(owner)) {
          return null;
        }

        notify.error(t('workflowLibrary.saveFailed'), getApiErrorMessage(error, t('common.unknownError')));
        return null;
      }
    },
    [notify, t]
  );

  return { saveDocumentAsNew, saveToLibrary };
};
