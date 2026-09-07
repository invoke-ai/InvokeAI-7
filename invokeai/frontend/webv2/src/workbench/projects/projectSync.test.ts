import type { Project } from '@workbench/projectContracts';

import { createInitialWorkbenchState, workbenchReducer } from '@workbench/workbenchState.testing';
import { describe, expect, it } from 'vitest';

import {
  applyAuthoritativeProjectBoard,
  serializeProjectDocumentV2,
  serializeProjectDocumentV2Json,
} from './projectDocument';
import { deserializeProjectDocument, deserializeProjectRecord, serializeProjectDocument } from './syncedPersistence';

const getProject = (overrides: Partial<Project> = {}): Project => {
  const state = createInitialWorkbenchState();

  return { ...state.projects[0], ...overrides };
};

const loadDocument = (document: Record<string, unknown>): Project => {
  const result = deserializeProjectDocument(document);

  if (result.status !== 'loaded') {
    throw new Error(`Expected the document to load, got ${result.status}.`);
  }

  return result.project;
};

describe('project document serialization', () => {
  it('serializes only the V2 durable allowlist and restores session state empty', () => {
    const project = getProject();

    project.undoRedo.past.push({
      createdAt: 'now',
      id: 'undo-1',
      label: 'test',
      project: {
        invocation: project.invocation,
        layout: project.layout,
        projectGraph: project.projectGraph,
        widgetGraphs: {},
        widgetInstances: project.widgetInstances,
        widgetRegions: project.widgetRegions,
      },
    });
    project.queue.items.push({} as never);
    project.events.push({} as never);
    Object.assign(project, {
      futureField: 'must-not-leak',
      recoveredAt: '2026-01-01T00:00:00.000Z',
      recoveryOf: 'old-project',
    });

    const document = serializeProjectDocumentV2(project);

    expect(Object.keys(document).sort()).toEqual(
      [
        'canvas',
        'documentSchemaVersion',
        'id',
        'invocation',
        'layout',
        'name',
        'projectGraph',
        'promptHistory',
        'settings',
        'widgetGraphs',
        'widgetInstances',
        'widgetRegions',
      ].sort()
    );
    expect(document.documentSchemaVersion).toBe(2);

    const roundTripped = loadDocument(document);

    expect(roundTripped.undoRedo).toEqual({ future: [], past: [] });
    expect(roundTripped.queue).toEqual({ items: [] });
    expect(roundTripped.events).toEqual([]);
    expect(roundTripped.id).toBe(project.id);
    expect(roundTripped.widgetInstances).toEqual(project.widgetInstances);
  });

  it('measures the exact UTF-8 wire bytes once', () => {
    const project = getProject({ name: '文書' });
    const encoded = serializeProjectDocumentV2Json(project);

    expect(encoded.document).toEqual(serializeProjectDocumentV2(project));
    expect(encoded.documentJson).toBe(JSON.stringify(encoded.document));
    expect(encoded.byteSize).toBe(new TextEncoder().encode(encoded.documentJson).byteLength);
  });

  it('keeps project document bytes constant as session queue history grows', () => {
    const project = getProject();
    const baseline = serializeProjectDocumentV2Json(project);
    project.queue.items = Array.from({ length: 2_000 }, (_, index) => ({
      id: `queue-${index}`,
      snapshot: { oversizedContext: 'x'.repeat(100) },
    })) as never;

    const withQueueHistory = serializeProjectDocumentV2Json(project);

    expect(withQueueHistory.byteSize).toBe(baseline.byteSize);
    expect(withQueueHistory.documentJson).toBe(baseline.documentJson);
  });

  it('excludes session state and legacy history from project files', () => {
    const project = getProject();
    Object.assign(project, { graphHistory: [{ id: 'legacy-snapshot' }] });

    const document = serializeProjectDocument(project);

    expect(document).not.toHaveProperty('events');
    expect(document).not.toHaveProperty('graphHistory');
    expect(document).not.toHaveProperty('queue');
  });

  it('rejects documents that do not look like projects', () => {
    expect(deserializeProjectDocument({})).toEqual({ status: 'unavailable' });
    expect(deserializeProjectDocument({ id: 'x' })).toEqual({ status: 'unavailable' });
    expect(deserializeProjectDocument({ id: 'x', layout: null, name: 'y' })).toEqual({ status: 'unavailable' });
  });

  it('refuses a document whose canvas was written by a newer client, keeping the raw document', () => {
    const project = getProject();
    const document = serializeProjectDocument(project);
    const future = { ...document, canvas: { ...(document.canvas as object), version: 4 } };

    const result = deserializeProjectDocument(future);

    expect(result).toMatchObject({
      refused: {
        projectId: project.id,
        raw: future,
        refusal: { scope: 'state', status: 'unsupported-version', version: 4 },
        source: 'canvas',
      },
      status: 'refused',
    });
  });

  it('refuses a newer project document schema while preserving its raw bytes for export', () => {
    const project = getProject();
    const future = { ...serializeProjectDocumentV2(project), documentSchemaVersion: 3 };

    expect(deserializeProjectDocument(future)).toEqual({
      refused: {
        projectId: project.id,
        projectName: project.name,
        raw: future,
        refusal: {
          raw: future,
          scope: 'project-document',
          status: 'unsupported-version',
          version: 3,
        },
        source: 'project-document',
      },
      status: 'refused',
    });
  });

  it('uses authoritative server identity and untouched bytes for a future document refusal', () => {
    const raw = {
      documentSchemaVersion: 3,
      id: 'untrusted-id',
      name: 'Untrusted name',
      widgetInstances: {
        gallery: { state: { values: { boardId: 'stale-board' } }, typeId: 'gallery' },
      },
    };

    expect(
      deserializeProjectRecord({
        board_id: 'authoritative-board',
        created_at: '2026-09-03T00:00:00.000Z',
        data: raw,
        minimum_canvas_schema_version: 3,
        name: 'Authoritative name',
        project_id: 'authoritative-id',
        revision: 4,
        updated_at: '2026-09-03T00:00:00.000Z',
      })
    ).toEqual({
      refused: {
        projectId: 'authoritative-id',
        projectName: 'Authoritative name',
        raw,
        refusal: { raw, scope: 'project-document', status: 'unsupported-version', version: 3 },
        source: 'project-document',
      },
      status: 'refused',
    });
  });

  it('normalizes legacy project-graph invocation sources to workflow', () => {
    const project = getProject({
      invocation: { destination: 'gallery', destinationLocked: false, sourceId: 'workflow', sourceLocked: false },
    });
    const document = serializeProjectDocument(project);

    document.invocation = {
      destination: 'gallery',
      destinationLocked: false,
      sourceId: 'project-graph',
      sourceLocked: false,
    };

    const deserialized = loadDocument(document);

    expect(deserialized.invocation.sourceId).toBe('workflow');
    expect(deserialized.queue.items).toEqual([]);
  });
});

describe('openProject', () => {
  it('appends the hydrated project and makes it active', () => {
    const state = createInitialWorkbenchState();
    const opened = getProject({ id: 'project-from-library', name: 'Reopened' });

    const next = workbenchReducer(state, { project: opened, type: 'openProject' });

    expect(next.projects.map((project) => project.id)).toEqual([state.projects[0].id, opened.id]);
    expect(next.activeProjectId).toBe(opened.id);
  });

  it('focuses an already-open project instead of duplicating it', () => {
    const state = createInitialWorkbenchState();
    const existing = state.projects[0];
    const background = getProject({ id: 'project-background' });
    const withTwo = workbenchReducer(state, { project: background, type: 'openProject' });

    const next = workbenchReducer(withTwo, { project: existing, type: 'openProject' });

    expect(next.projects).toHaveLength(2);
    expect(next.activeProjectId).toBe(existing.id);
  });
});

describe('renameProject', () => {
  it('renames the target project and ignores blank names', () => {
    const state = createInitialWorkbenchState();
    const target = state.projects[0];

    const renamed = workbenchReducer(state, { name: '  New Name  ', projectId: target.id, type: 'renameProject' });

    expect(renamed.projects[0].name).toBe('New Name');

    const blank = workbenchReducer(renamed, { name: '   ', projectId: target.id, type: 'renameProject' });

    expect(blank.projects[0].name).toBe('New Name');
  });
});

/**
 * SQLite owns which board belongs to which project; the document only caches it. This is the one
 * place that writes that cache, so every path — hydration, create, import, duplicate, fork —
 * agrees on what "the project's board" means.
 */
describe('applyAuthoritativeProjectBoard', () => {
  const galleryDocument = (values: Record<string, unknown>): Record<string, unknown> => ({
    widgetInstances: {
      'canvas-1': { state: { values: { projectBoardId: 'not-the-gallery' } }, typeId: 'canvas' },
      'gallery-1': { state: { values }, typeId: 'gallery' },
    },
  });

  const galleryValues = (document: Record<string, unknown>): Record<string, unknown> =>
    (
      (document.widgetInstances as Record<string, { state: { values: Record<string, unknown> } }>)['gallery-1'] as {
        state: { values: Record<string, unknown> };
      }
    ).state.values;

  it('replaces the project board and leaves a chosen destination alone', () => {
    const patched = applyAuthoritativeProjectBoard(
      galleryDocument({ galleryView: 'assets', projectBoardId: 'stale', selectedBoardId: 'chosen' }),
      'authoritative',
      { selectBoard: false }
    );

    expect(galleryValues(patched)).toEqual({
      galleryView: 'assets',
      projectBoardId: 'authoritative',
      selectedBoardId: 'chosen',
    });
  });

  it('also points a first-seen project at its board', () => {
    const patched = applyAuthoritativeProjectBoard(galleryDocument({ selectedBoardId: 'chosen' }), 'authoritative', {
      selectBoard: true,
    });

    expect(galleryValues(patched).selectedBoardId).toBe('authoritative');
  });

  it('only touches the gallery widget', () => {
    const patched = applyAuthoritativeProjectBoard(galleryDocument({}), 'authoritative', { selectBoard: true });
    const instances = patched.widgetInstances as Record<string, { state: { values: Record<string, unknown> } }>;

    expect(instances['canvas-1']!.state.values.projectBoardId).toBe('not-the-gallery');
  });

  it('patches the legacy widget-states shape too', () => {
    const patched = applyAuthoritativeProjectBoard(
      { widgetStates: { gallery: { values: { projectBoardId: 'stale' } } } },
      'authoritative',
      { selectBoard: true }
    ) as { widgetStates: { gallery: { values: Record<string, unknown> } } };

    expect(patched.widgetStates.gallery.values).toEqual({
      projectBoardId: 'authoritative',
      selectedBoardId: 'authoritative',
    });
  });

  it('invents no shape for a document with no gallery', () => {
    const document = { id: 'p1', name: 'No gallery' };

    expect(applyAuthoritativeProjectBoard(document, 'authoritative', { selectBoard: true })).toBe(document);
  });
});
