import type { Project } from '@workbench/projectContracts';

import { stripInfiniteWindowAnchor, stripSessionScopedGallerySearch } from '@features/gallery/contracts';

/**
 * The project *document* codec: the wire and file shape of a project, and the
 * migrations that heal older ones. It deliberately knows nothing about the
 * Workbench reducer.
 *
 * Rehydrating a document into a live `Project` needs `loadWorkbenchProject`
 * from the aggregate state module, which transitively owns generation graphs,
 * widget state, and every policy the editor runs on. Keeping that step out of
 * this module is what lets the Launchpad read, write, and shape-check project
 * files without paying for the editor — see `deserializeProjectDocument` in
 * `./syncedPersistence` for the rehydrating half.
 */

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
 * Write the server's board id into a project document's gallery state.
 *
 * The server owns the project-to-board relationship; `projectBoardId` in the document is only a
 * cache of it. Every path that learns the authoritative id — hydrating a record, creating a
 * project, importing one, duplicating one, forking a conflicted one — comes through here, so there
 * is one place that decides what "the project's board" means in a document.
 *
 * `selectBoard` distinguishes the two cases. A project the user is meeting for the first time
 * should also be *pointed* at its board; one being re-hydrated should keep whatever destination
 * the user last chose, which `getGallerySelectedBoardId` resolves separately.
 *
 * Both widget shapes are patched — the current `widgetInstances` map and the `widgetStates.gallery`
 * one older builds wrote — and a document with neither is returned untouched rather than having a
 * shape invented for it.
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

/**
 * The minimum a document must carry to be a project at all. A document that
 * fails this can never rehydrate, so callers that only need to reject junk
 * (an import picker, a file preview) can stop here instead of loading the
 * reducer to find out.
 */
export const isProjectDocumentShape = (data: Record<string, unknown>): boolean =>
  typeof data.id === 'string' &&
  typeof data.name === 'string' &&
  typeof data.layout === 'object' &&
  data.layout !== null &&
  (data.documentSchemaVersion === undefined || data.documentSchemaVersion === PROJECT_DOCUMENT_SCHEMA_VERSION);
