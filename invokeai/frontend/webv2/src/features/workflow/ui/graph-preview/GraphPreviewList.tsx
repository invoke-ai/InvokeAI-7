import type { WorkflowPreviewGraph } from '@features/workflow/ui/contracts';

import { Badge, Button, Stack, Text } from '@chakra-ui/react';
import { getTopologicalOrder } from '@features/workflow/core/graphLayout';
import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { getNodeSubtitle } from './nodeSummaries';

type PreviewListNode = WorkflowPreviewGraph['nodes'][number];

const GraphPreviewListRow = ({ node, onSelect }: { node: PreviewListNode; onSelect: (nodeId: string) => void }) => {
  const { t } = useTranslation();
  const subtitle =
    getNodeSubtitle(node, t) ??
    `${node.id} · ${t('graphPreview.inputCount', { count: Object.keys(node.inputs).length })}`;
  const handleClick = useCallback(() => onSelect(node.id), [node.id, onSelect]);

  return (
    <Button
      fontWeight="normal"
      h="auto"
      justifyContent="flex-start"
      px="3"
      py="2"
      variant="ghost"
      w="full"
      onClick={handleClick}
    >
      <Stack align="flex-start" gap="0.5" w="full">
        <Badge fontFamily="mono" size="xs">
          {node.type}
        </Badge>
        <Text color="fg.muted" fontSize="2xs" fontWeight="normal" truncate>
          {subtitle}
        </Text>
      </Stack>
    </Button>
  );
};

/**
 * Expose all nodes in topological rows for keyboard/screen-reader access to the shared inspector; plain Chakra
 * avoids unnecessary platform-barrel fan-in.
 */
export const GraphPreviewList = ({
  graph,
  onSelect,
}: {
  graph: WorkflowPreviewGraph;
  onSelect: (nodeId: string) => void;
}) => {
  // Recompute sorted rows only when the graph changes, not on unrelated live-source renders.
  const orderedNodes = useMemo(() => {
    const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
    const order = getTopologicalOrder(
      graph.nodes,
      graph.edges.map((edge) => ({ sourceNodeId: edge.sourceNodeId, targetNodeId: edge.targetNodeId }))
    );

    return order.map((nodeId) => nodesById.get(nodeId)).filter((node): node is PreviewListNode => node !== undefined);
  }, [graph]);

  return (
    <Stack gap="1" h="full" overflowY="auto" p="2">
      {orderedNodes.map((node) => (
        <GraphPreviewListRow key={node.id} node={node} onSelect={onSelect} />
      ))}
    </Stack>
  );
};
