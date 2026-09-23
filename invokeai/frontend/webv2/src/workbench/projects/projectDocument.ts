import type { Project } from '@workbench/projectContracts';

import { stripInfiniteWindowAnchor, stripSessionScopedGallerySearch } from '@features/gallery/contracts';

/** Keep document codecs reducer-free; load rehydration lazily. */

export const PROJECT_DOCUMENT_SCHEMA_VERSION = 2;
export const PROJECT_DOCUMENT_MAX_BYTES = 32 * 1024 * 1024;

export type ProjectDocumentV2 = Omit<
  Pick<
    Project,
    | 'canvas'
    | 'floatingWidgets'
    | 'id'
    | 'invocation'
    | 'layout'
    | 'name'
    | 'projectGraph'
    | 'promptHistory'
    | 'settings'
    | 'widgetGraphs'
    | 'widgetInstances'
    | 'widgetRegions'
  >,
  'floatingWidgets'
> & {
  documentSchemaVersion: typeof PROJECT_DOCUMENT_SCHEMA_VERSION;
  floatingWidgets?: Project['floatingWidgets'];
};

export const stripSessionScopedGalleryState = (project: Project): Project => {
  let didChange = false;
  const widgetInstances = Object.fromEntries(
    Object.entries(project.widgetInstances).map(([instanceId, instance]) => {
      if (instance.typeId !== 'gallery') {
        return [instanceId, instance];
      }
      const values = instance.state.values;
      const strippedValues = stripSessionScopedGallerySearch(values);
      const strippedAnchorValues = stripInfiniteWindowAnchor(strippedValues ?? values);
      if (strippedValues === null && strippedAnchorValues === null) {
        return [instanceId, instance];
      }
      didChange = true;
      return [
        instanceId,
        { ...instance, state: { ...instance.state, values: strippedAnchorValues ?? strippedValues ?? values } },
      ];
    })
  );

  return didChange ? { ...project, widgetInstances } : project;
};

export const serializeProjectDocumentV2 = (project: Project): ProjectDocumentV2 => {
  const persistent = stripSessionScopedGalleryState(project);
  const document: ProjectDocumentV2 = {
    canvas: persistent.canvas,
    documentSchemaVersion: PROJECT_DOCUMENT_SCHEMA_VERSION,
    ...(persistent.floatingWidgets ? { floatingWidgets: persistent.floatingWidgets } : {}),
    id: persistent.id,
    invocation: persistent.invocation,
    layout: persistent.layout,
    name: persistent.name,
    projectGraph: persistent.projectGraph,
    promptHistory: persistent.promptHistory,
    settings: persistent.settings,
    widgetGraphs: persistent.widgetGraphs,
    widgetInstances: persistent.widgetInstances,
    widgetRegions: persistent.widgetRegions,
  };

  return document;
};

export const serializeProjectDocumentV2Json = (
  project: Project
): { byteSize: number; document: ProjectDocumentV2; documentJson: string } => {
  const document = serializeProjectDocumentV2(project);
  const documentJson = JSON.stringify(document);

  return { byteSize: new TextEncoder().encode(documentJson).byteLength, document, documentJson };
};

export const serializeProjectDocument = (project: Project): Record<string, unknown> => {
  const {
    events: _events,
    graphHistory: _graphHistory,
    queue: _queue,
    undoRedo: _undoRedo,
    ...document
  } = stripSessionScopedGalleryState(project) as Project & { graphHistory?: unknown };

  return document;
};

const normalizeInvocationSourceId = (sourceId: unknown): unknown => {
  if (sourceId === 'project-graph') {
    return 'workflow';
  }

  if (sourceId === 'canvas-fill') {
    return 'canvas';
  }

  return sourceId;
};

export const normalizeLegacyProjectDocument = (data: Record<string, unknown>): Record<string, unknown> => {
  const invocation = data.invocation;
  const { events: _events, graphHistory: _graphHistory, queue: _queue, ...document } = data;

  return {
    ...document,
    invocation:
      invocation && typeof invocation === 'object'
        ? { ...invocation, sourceId: normalizeInvocationSourceId((invocation as { sourceId?: unknown }).sourceId) }
        : invocation,
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const patchGalleryValues = (
  values: Record<string, unknown>,
  boardId: string,
  selectBoard: boolean
): Record<string, unknown> => ({
  ...values,
  projectBoardId: boardId,
  ...(selectBoard ? { selectedBoardId: boardId } : {}),
});

/**
 * Cache the server-authoritative board ID in either persisted widget shape. selectBoard selects it on first open;
 * rehydration preserves the user's destination. Leave documents without gallery state untouched.
 */
export const applyAuthoritativeProjectBoard = (
  projectDocument: Record<string, unknown>,
  boardId: string,
  options: { selectBoard: boolean }
): Record<string, unknown> => {
  let hasChanged = false;
  const next: Record<string, unknown> = { ...projectDocument };

  const instances = projectDocument.widgetInstances;
  if (isRecord(instances)) {
    const nextInstances: Record<string, unknown> = {};

    for (const [instanceId, instance] of Object.entries(instances)) {
      const state = isRecord(instance) ? instance.state : null;

      if (!isRecord(instance) || instance.typeId !== 'gallery' || !isRecord(state)) {
        nextInstances[instanceId] = instance;
        continue;
      }

      const values = isRecord(state.values) ? state.values : {};

      nextInstances[instanceId] = {
        ...instance,
        state: { ...state, values: patchGalleryValues(values, boardId, options.selectBoard) },
      };
      hasChanged = true;
    }

    next.widgetInstances = nextInstances;
  }

  const states = projectDocument.widgetStates;
  if (isRecord(states) && isRecord(states.gallery)) {
    const gallery = states.gallery;
    const values = isRecord(gallery.values) ? gallery.values : {};

    next.widgetStates = {
      ...states,
      gallery: { ...gallery, values: patchGalleryValues(values, boardId, options.selectBoard) },
    };
    hasChanged = true;
  }

  return hasChanged ? next : projectDocument;
};

/** Reject invalid document formats without eagerly loading the reducer. */
export const isProjectDocumentShape = (data: Record<string, unknown>): boolean =>
  typeof data.id === 'string' &&
  typeof data.name === 'string' &&
  typeof data.layout === 'object' &&
  data.layout !== null &&
  (data.documentSchemaVersion === undefined || data.documentSchemaVersion === PROJECT_DOCUMENT_SCHEMA_VERSION);
