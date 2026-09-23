import type { StarterModel } from '@features/models';
import type { WidgetViewProps } from '@workbench/widgetContracts';
import type { ReactNode } from 'react';

import { Box, Button, Center, Link, Spinner, Stack, Text } from '@chakra-ui/react';
import {
  ensureStartersLoaded,
  getStarterModelInstallSources,
  useActiveInstallSources,
  useInstallActions,
  useStartersSelector,
} from '@features/models';
import { useMountEffect } from '@platform/react/useMountEffect';
import { getImageMapClickSelectsCluster, getImageMapShowClusterLabels } from '@workbench/image-map/imageMapSettings';
import {
  ensureImageMapLoaded,
  imageMapStore,
  refreshImageIndexStatus,
  refreshImageMapPoints,
  setClusterLabelsEnabled,
} from '@workbench/image-map/imageMapStore';
import { isIndexing } from '@workbench/image-map/indexProgress';
import { useWidgetValuesSelector } from '@workbench/WorkbenchContext';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef } from 'react';

import { ImageIndexActivityBadge, ImageIndexProgressPanel } from './ImageIndexProgress';

// Load Plotly only when the map widget is shown.
const ImageMapPlot = lazy(() => import('./ImageMapPlot'));

const handleRefresh = () => {
  void refreshImageMapPoints();
  // Retry counts as well as points; stale progress is often why retry was requested.
  refreshImageIndexStatus();
};

// Use the configured default model name when older/empty responses cannot name the missing encoder.
const DEFAULT_IMAGE_INDEX_MODEL = 'DFN2B-CLIP-ViT-L-14-39B';

const EMPTY_STARTERS: readonly StarterModel[] = [];

const selectStarterModels = (snapshot: {
  response: { starter_models: StarterModel[] } | null;
}): readonly StarterModel[] => snapshot.response?.starter_models ?? EMPTY_STARTERS;

const plotLoadingFallback = (
  <Center h="full">
    <Spinner size="lg" />
  </Center>
);

/** Show backend embeddings projected by UMAP and colored by cluster; point selection drives Gallery and Preview. */
export const ImageMapWidgetView = (_props: WidgetViewProps) => {
  const { data, error, indexCounts, indexUpdatedAt, loadState, renderError } = imageMapStore.useSnapshot();
  const clickSelectsCluster = useWidgetValuesSelector('image-map', getImageMapClickSelectsCluster);
  const showClusterLabels = useWidgetValuesSelector('image-map', getImageMapShowClusterLabels);

  useEffect(() => {
    ensureImageMapLoaded();
  }, []);

  // Pushed into the store so turning labels off stops the request, not just the
  // drawing of what it returns.
  useEffect(() => {
    setClusterLabelsEnabled(showClusterLabels);
  }, [showClusterLabels]);

  // Handle render failure before points so the same broken canvas cannot remount until refresh clears it.
  if (renderError) {
    return (
      <CenteredMessage
        actionLabel="Retry"
        detail={renderError}
        onAction={handleRefresh}
        title="Image map unavailable"
      />
    );
  }

  // A working map beats a full-screen error: when a refresh fails but prior
  // points exist, keep showing them (the next successful refresh recovers).
  if (data && data.points.length > 0) {
    // Keep a nested Suspense boundary around Plotly so its separate lazy load preserves widget chrome and places
    // loading feedback in the plot area.
    return (
      // Overlay indexing status on usable stale points because this branch bypasses the progress panel.
      <Box h="full" position="relative" w="full">
        <Suspense fallback={plotLoadingFallback}>
          <ImageMapPlot clickSelectsCluster={clickSelectsCluster} showClusterLabels={showClusterLabels} />
        </Suspense>
        {isIndexing(indexCounts) ? <ImageIndexActivityBadge counts={indexCounts} updatedAt={indexUpdatedAt} /> : null}
      </Box>
    );
  }

  const retainedDataError = loadState === 'error' ? (error ?? 'Failed to load the image map.') : null;

  // Ahead of the loading spinner, unlike every other message: a refresh from
  // this state flips `loadState` to `loading`, and flashing a spinner over the
  // message would unmount the install link — losing the in-flight download's
  // pending state and the "refresh when it lands" watcher with it. The
  // diagnosis is also what a refresh is least likely to change.
  if (data?.state === 'model_missing') {
    return (
      <CenteredMessage
        // Keep a standing refresh action to discover newly installed encoders while the indexer is otherwise
        // inert.
        actionLabel={retainedDataError ? 'Retry' : 'Check again'}
        detail={
          <>
            To enable image indexing, install the image encoder model{' '}
            <ImageIndexModelInstallLink modelName={data.modelName?.trim() || DEFAULT_IMAGE_INDEX_MODEL} /> from the
            Model Manager to build a semantic index of your gallery.
          </>
        }
        errorDetail={retainedDataError}
        onAction={handleRefresh}
        title="Embedding model not installed"
      />
    );
  }

  if (loadState === 'idle' || loadState === 'loading') {
    return (
      <Center h="full">
        <Spinner size="lg" />
      </Center>
    );
  }

  if (loadState === 'error' && !data) {
    return (
      <CenteredMessage
        actionLabel="Retry"
        detail={error ?? 'Failed to load the image map.'}
        onAction={handleRefresh}
        title="Image map unavailable"
      />
    );
  }

  if (!data || data.state === 'disabled') {
    return (
      <CenteredMessage
        actionLabel={retainedDataError ? 'Retry' : undefined}
        detail="To enable image indexing, set `image_index_enabled: true` in the server configuration file and restart the server to build a semantic index of your gallery."
        errorDetail={retainedDataError}
        onAction={retainedDataError ? handleRefresh : undefined}
        title="Image indexing is off"
      />
    );
  }

  // Prioritize backfill progress over computing/empty states before points exist. Preserve refresh errors and
  // retry within that panel.
  if (isIndexing(indexCounts)) {
    return (
      <Center h="full" p="6">
        <ImageIndexProgressPanel
          counts={indexCounts}
          error={loadState === 'error' ? (error ?? 'Failed to load the image map.') : null}
          updatedAt={indexUpdatedAt}
          onRetry={handleRefresh}
        />
      </Center>
    );
  }

  if (data.state === 'computing') {
    return (
      <Center h="full">
        <Stack align="center" gap="3">
          <Spinner size="lg" />
          <Text color="fg.muted" fontSize="sm">
            Computing your image map…
          </Text>
          <Button onClick={handleRefresh} size="xs" variant="outline">
            Check again
          </Button>
        </Stack>
      </Center>
    );
  }

  if (loadState === 'error') {
    return (
      <CenteredMessage
        actionLabel="Retry"
        detail={error ?? 'Failed to load the image map.'}
        onAction={handleRefresh}
        title="Image map unavailable"
      />
    );
  }

  return (
    <CenteredMessage
      detail="Generate or import images and videos and they will appear here, clustered by visual similarity."
      title="Nothing to map yet"
    />
  );
};

const CenteredMessage = ({
  actionLabel,
  detail,
  errorDetail,
  onAction,
  title,
}: {
  title: string;
  detail: ReactNode;
  actionLabel?: string;
  errorDetail?: string | null;
  onAction?: () => void;
}) => (
  <Center h="full" p="6">
    <Stack align="center" gap="2" maxW="sm" textAlign="center">
      <Text fontWeight="semibold">{title}</Text>
      <Text color="fg.muted" fontSize="sm">
        {detail}
      </Text>
      {errorDetail ? (
        <Text color="fg.error" fontSize="sm" maxW="full" minW="0" overflowWrap="anywhere" role="alert">
          {errorDetail}
        </Text>
      ) : null}
      {actionLabel && onAction ? (
        <Button mt="2" onClick={onAction} size="xs" variant="outline">
          {actionLabel}
        </Button>
      ) : null}
    </Stack>
  </Center>
);

/**
 * Offer one-click encoder installation when the starter catalog resolves it; otherwise show text while unknown,
 * loading, or already downloading.
 */
const ImageIndexModelInstallLink = ({ modelName }: { modelName: string }) => {
  const starterModels = useStartersSelector(selectStarterModels);
  const activeInstallSources = useActiveInstallSources();
  const { install, pendingSources } = useInstallActions();

  useMountEffect(() => {
    ensureStartersLoaded();
  });

  const sources = useMemo(() => {
    const starter = starterModels.find((candidate) => candidate.name === modelName);

    return starter ? getStarterModelInstallSources(starter) : [];
  }, [modelName, starterModels]);

  const installing = sources.some(
    (entry) => pendingSources.has(entry.source) || activeInstallSources.has(entry.source)
  );
  const wasInstalling = useRef(false);

  // The server picks a freshly installed encoder up on the next map request,
  // so ask for one as soon as the download lands: without it the panel keeps
  // saying "not installed" until someone reopens it.
  useEffect(() => {
    if (wasInstalling.current && !installing) {
      handleRefresh();
    }

    wasInstalling.current = installing;
  }, [installing]);

  const handleInstall = useCallback(() => {
    void (async () => {
      // Sequential, matching the Add Models starter path: the install queue is
      // ordered anyway, and a dependency must not race the model that needs it.
      for (const entry of sources) {
        // Re-checked here rather than trusted from the render that drew the
        // link: an install of the same source may have started elsewhere (the
        // Models page, another tab) in between, and queueing it twice
        // downloads it twice.
        if (pendingSources.has(entry.source) || activeInstallSources.has(entry.source)) {
          continue;
        }

        await install(entry);
      }
    })();
  }, [activeInstallSources, install, pendingSources, sources]);

  if (sources.length === 0 || installing) {
    return (
      <Text as="span" fontWeight="medium">
        {modelName}
        {installing ? ' (installing…)' : ''}
      </Text>
    );
  }

  return (
    <Link as="button" colorPalette="accent" onClick={handleInstall} type="button" variant="underline">
      {modelName}
    </Link>
  );
};
