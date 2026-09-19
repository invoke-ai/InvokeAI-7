import type { WorkflowRecordDTO } from '@features/workflow/data/api';

import { onWorkflowLibraryCacheInvalidated } from '@features/workflow/data/libraryCache';
import {
  getSavedWorkflowDetailQueryStatus,
  isSavedWorkflowDetailQueryKey,
  savedWorkflowDetailQueryOptions,
  shouldFetchSavedWorkflowDetail,
} from '@features/workflow/data/savedWorkflowQueries';
import { getInvocationTemplatesSnapshot, subscribeInvocationTemplates } from '@features/workflow/data/templates';
import { useWorkflowUi } from '@features/workflow/ui/WorkflowUiContext';
import {
  CALL_SAVED_WORKFLOW_DYNAMIC_FIELD_PREFIX,
  getSavedWorkflowDynamicEdgeIdsToRemove,
  getSavedWorkflowDynamicFields,
  getSelectedSavedWorkflow,
  parseWorkflowJson,
} from '@features/workflow/utility';
import { useMountEffect } from '@platform/react/useMountEffect';
import { useQueryClient } from '@tanstack/react-query';

export const createDeferredCallSavedWorkflowReconciler = (reconcile: () => void) => {
  let timer: ReturnType<typeof setTimeout> | null = null;

  return {
    dispose: () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
    schedule: () => {
      if (timer !== null) {
        return;
      }

      timer = setTimeout(() => {
        timer = null;
        reconcile();
      }, 0);
    },
  };
};

const hasSameFieldType = (left: unknown, right: unknown): boolean => {
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') {
    return false;
  }

  const leftType = (left as { type?: unknown }).type;
  const rightType = (right as { type?: unknown }).type;

  if (!leftType || !rightType || typeof leftType !== 'object' || typeof rightType !== 'object') {
    return false;
  }

  return (
    (leftType as { name?: unknown }).name === (rightType as { name?: unknown }).name &&
    (leftType as { cardinality?: unknown }).cardinality === (rightType as { cardinality?: unknown }).cardinality &&
    (leftType as { batch?: unknown }).batch === (rightType as { batch?: unknown }).batch
  );
};

const needsDynamicFieldSync = (
  node: Parameters<typeof getSavedWorkflowDynamicEdgeIdsToRemove>[0]['nodes'][number],
  fields: ReturnType<typeof getSavedWorkflowDynamicFields>,
  edgeIdsToRemove: string[],
  edges: Parameters<typeof getSavedWorkflowDynamicEdgeIdsToRemove>[0]['edges']
): boolean => {
  if (node.type !== 'invocation') {
    return false;
  }

  const currentTemplates = node.data.dynamicInputTemplates ?? {};
  const currentDynamicNames = new Set([
    ...Object.keys(currentTemplates),
    ...Object.keys(node.data.inputs).filter((name) => name.startsWith(CALL_SAVED_WORKFLOW_DYNAMIC_FIELD_PREFIX)),
  ]);

  if (currentDynamicNames.size !== fields.length || fields.some((field) => !currentDynamicNames.has(field.fieldName))) {
    return true;
  }

  if (
    fields.some((field) => {
      const currentTemplate = currentTemplates[field.fieldName];
      const currentInstance = node.data.inputs[field.fieldName];

      return (
        !currentTemplate ||
        !currentInstance ||
        !hasSameFieldType(currentTemplate, field.fieldTemplate) ||
        JSON.stringify(currentTemplate) !== JSON.stringify(field.fieldTemplate) ||
        (currentInstance.label === currentTemplate.title && currentInstance.label !== field.label) ||
        ((currentInstance.description ?? '') === currentTemplate.description &&
          (currentInstance.description ?? '') !== field.description)
      );
    })
  ) {
    return true;
  }

  return edgeIdsToRemove.some((edgeId) => edges.some((edge) => edge.id === edgeId));
};

/** Reconciles asynchronously loaded child workflow forms into the project document. */
export const CallSavedWorkflowSyncRuntime = () => {
  const queryClient = useQueryClient();
  const { commands, project: projectPort } = useWorkflowUi();
  const reconcile = () => {
    const templatesSnapshot = getInvocationTemplatesSnapshot();

    if (templatesSnapshot.status !== 'loaded') {
      return;
    }

    const document = projectPort.getSnapshot().projectGraph;
    const setStatus = (nodeId: string, workflowId: string, status: 'loading' | 'ready' | 'error') => {
      const currentDocument = projectPort.getSnapshot().projectGraph;
      const currentNode = currentDocument.nodes.find((candidate) => candidate.id === nodeId);

      if (
        currentNode?.type === 'invocation' &&
        currentNode.data.type === 'call_saved_workflow' &&
        currentNode.data.inputs.workflow_id?.value === workflowId &&
        currentNode.data.callSavedWorkflowStatus !== status
      ) {
        commands.editGraph({ nodeId, status, type: 'setCallSavedWorkflowStatus' });
      }
    };

    for (const node of document.nodes) {
      if (node.type !== 'invocation' || node.data.type !== 'call_saved_workflow') {
        continue;
      }

      const workflowId =
        typeof node.data.inputs.workflow_id?.value === 'string' ? node.data.inputs.workflow_id.value : '';

      if (!workflowId) {
        const hasDynamicFields =
          Object.keys(node.data.dynamicInputTemplates ?? {}).length > 0 ||
          Object.keys(node.data.inputs).some((name) => name.startsWith(CALL_SAVED_WORKFLOW_DYNAMIC_FIELD_PREFIX));

        if (hasDynamicFields || node.data.callSavedWorkflowStatus !== 'ready') {
          commands.editGraph({
            edgeIdsToRemove: [],
            fields: [],
            nodeId: node.id,
            status: 'ready',
            type: 'syncCallSavedWorkflowFields',
          });
        }
        continue;
      }

      const detailOptions = savedWorkflowDetailQueryOptions(workflowId);
      const query = queryClient.getQueryCache().find({ queryKey: detailOptions.queryKey });

      if (shouldFetchSavedWorkflowDetail(query)) {
        setStatus(node.id, workflowId, 'loading');
        void queryClient.ensureQueryData({ ...detailOptions, revalidateIfStale: true }).catch(() => {
          setStatus(node.id, workflowId, 'error');
        });
        continue;
      }

      const queryStatus = getSavedWorkflowDetailQueryStatus(query);

      if (queryStatus === 'loading') {
        setStatus(node.id, workflowId, 'loading');
        continue;
      }

      if (queryStatus === 'error') {
        setStatus(node.id, workflowId, 'error');
        continue;
      }

      const record = query?.state.data as WorkflowRecordDTO | undefined;
      const selectedWorkflow = record ? getSelectedSavedWorkflow(workflowId, record) : undefined;

      if (!selectedWorkflow || selectedWorkflow.call_saved_workflow_compatibility?.is_callable === false) {
        setStatus(node.id, workflowId, 'error');
        continue;
      }

      let childDocument;

      try {
        childDocument = parseWorkflowJson(selectedWorkflow.workflow).document;
      } catch {
        childDocument = undefined;
      }

      if (!childDocument) {
        setStatus(node.id, workflowId, 'error');
        continue;
      }

      const fields = getSavedWorkflowDynamicFields(childDocument, templatesSnapshot.templates);
      const edgeIdsToRemove = getSavedWorkflowDynamicEdgeIdsToRemove(
        document,
        node.id,
        fields,
        templatesSnapshot.templates
      );

      if (
        node.data.callSavedWorkflowStatus !== 'ready' ||
        needsDynamicFieldSync(node, fields, edgeIdsToRemove, document.edges)
      ) {
        commands.editGraph({
          edgeIdsToRemove,
          fields,
          nodeId: node.id,
          status: 'ready',
          type: 'syncCallSavedWorkflowFields',
        });
      }
    }
  };

  /* eslint-disable react-hooks/rules-of-hooks -- useMountEffect is the repository's explicit useEffect wrapper */
  useMountEffect(() => {
    const reconciler = createDeferredCallSavedWorkflowReconciler(reconcile);
    reconciler.schedule();

    const unsubscribeProject = projectPort.subscribe(reconciler.schedule);
    const unsubscribeTemplates = subscribeInvocationTemplates(reconciler.schedule);
    const unsubscribeQueries = queryClient.getQueryCache().subscribe((event) => {
      if (isSavedWorkflowDetailQueryKey(event.query.queryKey)) {
        reconciler.schedule();
      }
    });
    const unsubscribeLibrary = onWorkflowLibraryCacheInvalidated(() => {
      void queryClient.invalidateQueries({ queryKey: ['workflow', 'call-saved', 'detail'] });
      reconciler.schedule();
    });

    return () => {
      reconciler.dispose();
      unsubscribeProject();
      unsubscribeTemplates();
      unsubscribeQueries();
      unsubscribeLibrary();
    };
  });
  /* eslint-enable react-hooks/rules-of-hooks */

  return null;
};
