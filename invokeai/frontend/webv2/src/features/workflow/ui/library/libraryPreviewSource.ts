import type { GraphPreviewSourceState, InvocationTemplates, ProjectGraphState } from '@features/workflow/contracts';

import { ForLoopGraphValidationError } from '@features/workflow/core/forLoops';
import { compileProjectGraph } from '@features/workflow/graph';

/**
 * Preview the entry's saved document without active-project destination or live updates; catch malformed cached
 * data despite ready enrichment.
 */
export const buildLibraryGraphPreviewSource = (
  document: ProjectGraphState,
  templates: InvocationTemplates
): GraphPreviewSourceState => {
  try {
    const graph = compileProjectGraph(document, templates);
    const positionHints = Object.fromEntries(document.nodes.map((node) => [node.id, node.position]));

    return {
      destinationLabel: null,
      graph,
      invalidReasons: [],
      isLive: false,
      notices: [],
      positionHints,
      summaryRows: [],
    };
  } catch (error) {
    return {
      destinationLabel: null,
      graph: null,
      invalidReasons: [
        error instanceof ForLoopGraphValidationError
          ? error.reason
          : error instanceof Error
            ? error.message
            : String(error),
      ],
      isLive: false,
      notices: [],
      summaryRows: [],
    };
  }
};
