import { getLibraryWorkflow, touchLibraryWorkflowOpenedAt } from '@features/workflow/data/api';
import { requestWorkflowFitView } from '@features/workflow/ui/editor/flowInstanceStore';
import { useProjectGraphCommands } from '@features/workflow/ui/useProjectGraphCommands';
import { useWorkflowNotifications } from '@features/workflow/ui/WorkflowUiContext';
import { parseWorkflowJson, serializeWorkflowJson } from '@features/workflow/utility';
import { useMountEffect } from '@platform/react/useMountEffect';
import {
  assertAccountScopeCurrent,
  captureAccountScope,
  isAccountScopeCurrent,
} from '@platform/state/accountLifecycle';
import { getApiErrorMessage } from '@platform/transport/http';
import { useTranslation } from 'react-i18next';

import { markLibraryGraphSynced } from './library/librarySyncBridge';
import { startWorkflowUiPendingLoadRuntime } from './pendingLibraryWorkflowLoadRuntime';

/**
 * Consumes pending workflow-load requests from surfaces that cannot reach the
 * graph context themselves: the command palette names a library record, an
 * image's context menu hands over the workflow it embeds. Either way the
 * document is parsed and replaces the project graph — the same load path as
 * WorkflowLibraryDialog, minus the dialog.
 */
export const PendingWorkflowLoader = () => {
  const { t } = useTranslation();
  const { replace } = useProjectGraphCommands();
  const notify = useWorkflowNotifications();
  useMountEffect(() => {
    const owner = captureAccountScope();

    return startWorkflowUiPendingLoadRuntime(async (source) => {
      try {
        assertAccountScopeCurrent(owner);

        let raw: unknown = null;
        let label = '';

        if (source.kind === 'library') {
          const record = await getLibraryWorkflow(source.workflowId, owner.signal);
          const name = typeof record.name === 'string' && record.name.length > 0 ? record.name : 'workflow';

          raw = record;
          label = t('commandPalette.workflowLoad.loaded', { name });
        } else {
          raw = source.raw;
          label = source.label;
        }

        assertAccountScopeCurrent(owner);
        const { document: parsed, warnings } = parseWorkflowJson(raw);
        // An embedded document may still carry the id of the library record it was
        // saved from; loading it must not start autosaving over that record.
        const document = source.kind === 'library' ? parsed : { ...parsed, libraryWorkflowId: undefined };

        replace(document, label);
        requestWorkflowFitView(document.nodes);

        if (source.kind === 'library') {
          // Same reasoning as the library dialog's load path: the graph just
          // loaded is already in sync with the library record it came from, so
          // mark it synced before the autosaver's graph-changed effect sees it.
          markLibraryGraphSynced(serializeWorkflowJson(document));
          void touchLibraryWorkflowOpenedAt(source.workflowId, owner.signal).catch(() => {
            // Recency bookkeeping only; loading already succeeded.
          });
        }

        for (const warning of warnings) {
          notify.info(t('commandPalette.workflowLoad.warning'), warning);
        }
      } catch (error) {
        if (!isAccountScopeCurrent(owner)) {
          return;
        }

        notify.error(
          t('commandPalette.workflowLoad.failed'),
          getApiErrorMessage(error, t('commandPalette.workflowLoad.couldNotLoad'))
        );
      }
    });
  });

  return null;
};
