import type { WorkflowLibraryBrowseSnapshot, WorkflowLibraryEntry } from '@features/workflow/data/libraryBrowseStore';
import type { WorkflowLibraryListItem } from '@features/workflow/queries';
import type { ChangeEvent } from 'react';

import { Dialog, HStack, Input, Portal, SegmentGroup, Spinner, Stack, Text } from '@chakra-ui/react';
import {
  ensureWorkflowLibraryBrowseLoaded,
  getWorkflowLibraryBrowseSnapshot,
  setWorkflowLibraryBrowseFilter,
  useWorkflowLibraryBrowseSelector,
} from '@features/workflow/data/libraryBrowseStore';
import { useInvocationTemplatesSnapshot } from '@features/workflow/react';
import { useMountEffect } from '@platform/react/useMountEffect';
import { CloseButton } from '@platform/ui';
import { lazy, Suspense, useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { buildLibraryGraphPreviewSource } from './libraryPreviewSource';
import { useLoadLibraryWorkflow } from './useLoadLibraryWorkflow';
import { WorkflowLibraryDetailPanel } from './WorkflowLibraryDetailPanel';
import { WorkflowLibraryGrid } from './WorkflowLibraryGrid';
import { WorkflowLibraryTagChips } from './WorkflowLibraryTagChips';
import { useWorkflowLibraryMissingCounts } from './WorkflowRequirementsList';

/** Load graph preview only on request to keep xyflow outside the library dialog's initial chunk. */
const LazyGraphPreviewDialog = lazy(() =>
  import('@features/workflow/ui/graph-preview/GraphPreviewDialog').then((module) => ({
    default: module.GraphPreviewDialog,
  }))
);

const SEARCH_DEBOUNCE_MS = 300;

const CATEGORY_ITEMS = [
  { labelKey: 'workflowLibrary.browse', value: 'default' },
  { labelKey: 'workflowLibrary.yours', value: 'user' },
] as const;

/** Flat and shallow-comparable, so unrelated store patches do not re-render the shell. */
const selectBrowseView = (snapshot: WorkflowLibraryBrowseSnapshot) => ({
  category: snapshot.filter.category,
  entries: snapshot.entries,
  error: snapshot.error,
  status: snapshot.status,
  tag: snapshot.filter.tag,
  tagCounts: snapshot.tagCounts,
});

/**
 * On open, load the first page and choose defaults for empty accounts only if filters have not changed during the
 * probe.
 */
const WorkflowLibraryBrowseSession = () => {
  useMountEffect(() => {
    void ensureWorkflowLibraryBrowseLoaded().then(() => {
      const { filter, userTotal } = getWorkflowLibraryBrowseSnapshot();

      if (userTotal === 0 && filter.category === 'user' && !filter.search) {
        setWorkflowLibraryBrowseFilter({ category: 'default', tag: null });
      }
    });
  });

  return null;
};

export const WorkflowLibraryDialog = ({
  isOpen,
  onOpenChange,
}: {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
}) => {
  const { t } = useTranslation();
  const { category, entries, error, status, tag, tagCounts } = useWorkflowLibraryBrowseSelector(selectBrowseView);
  const templatesSnapshot = useInvocationTemplatesSnapshot();
  const [searchInput, setSearchInput] = useState('');
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | null>(null);
  // Clear pending preview entries on every library-close path because the persistent shell otherwise resurrects
  // them on reopen.
  const [previewEntry, setPreviewEntry] = useState<WorkflowLibraryEntry | null>(null);
  // Close before clearing previewEntry so the lazy dialog remains mounted through its exit transition.
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);
  const [contextMenuPoint, setContextMenuPoint] = useState<{ x: number; y: number } | null>(null);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const closeDialog = useCallback(() => {
    // Closing the library removes its preview immediately; the parent surface is leaving too.
    setPreviewEntry(null);
    setIsPreviewOpen(false);
    setContextMenuPoint(null);
    onOpenChange(false);
  }, [onOpenChange]);
  const { load, loadPhase } = useLoadLibraryWorkflow(closeDialog);
  const isLoadPending = loadPhase !== 'idle';
  const missingCounts = useWorkflowLibraryMissingCounts(entries);

  // Derive a fallback selection when filtering/deletion removes the selected row.
  const activeWorkflowId = entries.some((entry) => entry.item.workflow_id === selectedWorkflowId)
    ? selectedWorkflowId
    : (entries[0]?.item.workflow_id ?? null);
  const activeEntry = entries.find((entry) => entry.item.workflow_id === activeWorkflowId) ?? null;

  const handleDialogOpenChange = useCallback(
    (event: { open: boolean }) => {
      if (isLoadPending) {
        return;
      }

      if (event.open) {
        onOpenChange(true);
      } else {
        closeDialog();
      }
    },
    [isLoadPending, onOpenChange, closeDialog]
  );

  const handlePreviewRequest = useCallback((entry: WorkflowLibraryEntry) => {
    setPreviewEntry(entry);
    setIsPreviewOpen(true);
  }, []);

  const handlePreviewOpenChange = useCallback((open: boolean) => {
    if (!open) {
      setIsPreviewOpen(false);
    }
  }, []);

  // Guarded on `isPreviewOpen`: previewing another card while the last one is
  // still animating out re-opens the same dialog, and an exit report that
  // arrives after that must not pull the mount out from under it.
  const handlePreviewExitComplete = useCallback(() => {
    if (!isPreviewOpen) {
      setPreviewEntry(null);
    }
  }, [isPreviewOpen]);

  // Only ready enrichment has a document; guard stale preview entries after revalidation.
  const previewSource = useMemo(() => {
    if (!previewEntry || previewEntry.enrichment.status !== 'ready' || templatesSnapshot.status !== 'loaded') {
      return null;
    }

    return buildLibraryGraphPreviewSource(previewEntry.enrichment.document, templatesSnapshot.templates);
  }, [previewEntry, templatesSnapshot]);

  const handleSearchChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const { value } = event.currentTarget;

    setSearchInput(value);

    if (searchTimerRef.current !== null) {
      clearTimeout(searchTimerRef.current);
    }

    // A post-unmount search debounce may update the browse store for the next opening.
    searchTimerRef.current = setTimeout(() => setWorkflowLibraryBrowseFilter({ search: value }), SEARCH_DEBOUNCE_MS);
  }, []);

  const handleCategoryChange = useCallback((event: { value: string | null }) => {
    // The store applies filter patches literally, so clearing the tag when the
    // category changes (its chips do not carry over) is the UI's job.
    if (event.value === 'default' || event.value === 'user') {
      setWorkflowLibraryBrowseFilter({ category: event.value, tag: null });
    }
  }, []);

  const handleTagSelect = useCallback((nextTag: string | null) => setWorkflowLibraryBrowseFilter({ tag: nextTag }), []);

  const handleOpenWorkflow = useCallback(
    (workflowId: string) => {
      const entry = getWorkflowLibraryBrowseSnapshot().entries.find(
        (candidate) => candidate.item.workflow_id === workflowId
      );

      if (entry) {
        void load(entry.item);
      }
    },
    [load]
  );

  const handleOpenItem = useCallback((item: WorkflowLibraryListItem) => void load(item), [load]);

  const handleDeleted = useCallback(() => {
    setSelectedWorkflowId(null);
    setContextMenuPoint(null);
  }, []);
  const handleCardContextMenu = useCallback(
    (workflowId: string, point: { x: number; y: number }) => {
      setSelectedWorkflowId(workflowId);

      // An open menu does not follow a new anchor: close it and reopen it at the
      // new point once that close has rendered, as a native menu relocates.
      if (contextMenuPoint) {
        setContextMenuPoint(null);
        requestAnimationFrame(() => setContextMenuPoint(point));
      } else {
        setContextMenuPoint(point);
      }
    },
    [contextMenuPoint]
  );
  const closeContextMenu = useCallback(() => setContextMenuPoint(null), []);

  return (
    <>
      <Dialog.Root open={isOpen} size="xl" onOpenChange={handleDialogOpenChange}>
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <Dialog.Content
              aria-busy={isLoadPending}
              h="80vh"
              maxH="80vh"
              maxW="min(72rem, calc(100vw - 4rem))"
              position="relative"
            >
              {isLoadPending ? (
                <Stack
                  alignItems="center"
                  aria-live="polite"
                  bg="bg/85"
                  inset="0"
                  justifyContent="center"
                  position="absolute"
                  role="status"
                  zIndex="modal"
                >
                  <Spinner color="accent.solid" size="lg" />
                  <Text fontSize="xs" fontWeight="600">
                    {loadPhase === 'fetching' ? t('workflowLibrary.fetching') : t('workflowLibrary.applying')}
                  </Text>
                </Stack>
              ) : null}
              <Dialog.Header>
                <Stack gap="2" minW="0" w="full">
                  <HStack gap="3" minW="0">
                    <Dialog.Title flexShrink={0}>{t('workflowLibrary.title')}</Dialog.Title>
                    <Input
                      aria-label={t('workflowLibrary.searchPlaceholder')}
                      flex="1"
                      minW="0"
                      placeholder={t('workflowLibrary.searchPlaceholder')}
                      size="xs"
                      type="search"
                      value={searchInput}
                      onChange={handleSearchChange}
                    />
                    <SegmentGroup.Root flexShrink={0} size="xs" value={category} onValueChange={handleCategoryChange}>
                      <SegmentGroup.Indicator />
                      {CATEGORY_ITEMS.map((item) => (
                        <SegmentGroup.Item key={item.value} value={item.value}>
                          <SegmentGroup.ItemHiddenInput />
                          <SegmentGroup.ItemText>{t(item.labelKey)}</SegmentGroup.ItemText>
                        </SegmentGroup.Item>
                      ))}
                    </SegmentGroup.Root>

                    <Dialog.CloseTrigger asChild>
                      <CloseButton
                        disabled={isLoadPending}
                        flexShrink={0}
                        insetEnd="auto"
                        position="static"
                        top="auto"
                      />
                    </Dialog.CloseTrigger>
                  </HStack>
                  <WorkflowLibraryTagChips selectedTag={tag} tagCounts={tagCounts} onSelect={handleTagSelect} />
                </Stack>
              </Dialog.Header>
              <Dialog.Body
                data-pending-preview={previewEntry?.item.workflow_id}
                display="flex"
                flex="1"
                gap="3"
                minH="0"
              >
                <WorkflowLibraryGrid
                  entries={entries}
                  error={error}
                  missingCounts={missingCounts}
                  selectedWorkflowId={activeWorkflowId}
                  status={status}
                  onContextMenu={handleCardContextMenu}
                  onOpen={handleOpenWorkflow}
                  onSelect={setSelectedWorkflowId}
                />
                <WorkflowLibraryDetailPanel
                  contextMenuPoint={contextMenuPoint}
                  entry={activeEntry}
                  onClose={closeDialog}
                  onContextMenuClose={closeContextMenu}
                  onDeleted={handleDeleted}
                  onDuplicated={setSelectedWorkflowId}
                  onOpen={handleOpenItem}
                  onPreview={handlePreviewRequest}
                />
              </Dialog.Body>
              {isOpen ? <WorkflowLibraryBrowseSession /> : null}
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>
      {previewEntry && previewSource ? (
        <Suspense fallback={null}>
          <LazyGraphPreviewDialog
            graphId={previewEntry.item.workflow_id}
            hideInvoke
            isOpen={isPreviewOpen}
            source={previewSource}
            sourceLabel={previewEntry.item.name || t('workflowLibrary.untitled')}
            onExitComplete={handlePreviewExitComplete}
            onOpenChange={handlePreviewOpenChange}
          />
        </Suspense>
      ) : null}
    </>
  );
};
