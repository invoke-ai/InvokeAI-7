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

// Lazy so the plotly bundle (its own vite chunk, ~1.5MB) loads only when the
// widget is actually shown.
const ImageMapPlot = lazy(() => import('./ImageMapPlot'));

const handleRefresh = () => {
  void refreshImageMapPoints();
  // The counts too: when the retry is the progress panel's, stale counts are
  // the likeliest reason the user pressed it.
  refreshImageIndexStatus();
};

// The backend reports the configured model name with `model_missing`, but a
// response that predates that field, a server that could not read the config,
// or an `image_index_model: ""` would otherwise leave the sentence with a hole
// where the model belongs; the config default is the right guess for all three.
const DEFAULT_IMAGE_INDEX_MODEL = 'DFN2B-CLIP-ViT-L-14-39B';

const EMPTY_STARTERS: readonly StarterModel[] = [];

const selectStarterModels = (snapshot: {
  response: { starter_models: StarterModel[] } | null;
}): readonly StarterModel[] => snapshot.response?.starter_models ?? EMPTY_STARTERS;

// Module scope: an inline element would be a new value on every render, which
// is both what react-perf/jsx-no-jsx-as-prop forbids and pointless here — the
// fallback never varies.
const plotLoadingFallback = (
  <Center h="full">
    <Spinner size="lg" />
  </Center>
);

/**
 * Semantic map of the gallery: every image embedded by the backend's image
 * index, projected to 2D with UMAP and colored by cluster. Clicking a point
 * selects that image in the gallery (and so in Preview).
 */
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

  // Checked before the plot: this is the canvas failing, not a fetch, so
  // re-mounting the plot would just fail again and render an empty box with no
  // way out. A successful refresh clears it and lets the plot retry.
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
    // Its own boundary, rather than leaning on WidgetRenderer's. That one wraps
    // the whole widget, so suspending on the plotly chunk replaced the entire
    // panel — header and actions menu included — with a skeleton frame, and
    // then held the resolved content for React's fallback throttle on top. It
    // also sits above `loadWidgets`, which preloads only the implementation
    // chunk and cannot reach this nested import, so a preset switch onto an
    // already-loaded map suspended anyway. Confining it here keeps the frame
    // mounted and the spinner where the plot will appear.
    return (
      // Positioned so the indexing badge can overlay the plot. That badge is
      // the only sign of an index run once there are points to draw: this
      // branch preempts the progress panel below, which is right — a usable
      // stale map beats a progress bar — but silently, which was not.
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
        // A standing action, not just an error retry: the server picks a newly
        // installed encoder up on a request, and nothing else polls while the
        // indexer is inert, so this button is the user's only way to ask again
        // without closing the widget.
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

  // Ahead of both `computing` and the empty state: with nothing to draw yet,
  // how far the backfill has got is the one thing that answers "when will
  // there be a map?" — a spinner or "nothing to map yet" leaves a user with a
  // large gallery unable to tell progress from a stall. `computing` is routine
  // here (the backend asks for a projection as soon as anything is embedded),
  // so deferring to it would hide the progress for most of a backfill.
  //
  // A failed refresh is carried into the panel rather than shadowed by it:
  // preempting the `error` branch below would otherwise drop both the message
  // and the only retry the widget has before the map is ready.
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
      detail="Generate or import images and they will appear here, clustered by visual similarity."
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
 * The configured encoder's name, as a one-click install when the starter
 * catalog carries it. Naming a model the user then has to go find by hand is
 * what made this message unactionable: the starter entry knows the source, so
 * the message can queue the download (and its dependencies) itself. Falls back
 * to plain text when the catalog has not loaded, does not know the name (a
 * hand-configured `image_index_model`), or the download is already running.
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
