import type { GalleryUiAdapter } from '@features/gallery/react';
import type { Project } from '@workbench/projectContracts';
import type { ReactNode } from 'react';

import { accountLifecycle } from '@platform/state/accountLifecycle';
import { getProjectWidgetValues } from '@workbench/widgetState';
import { createWorkbenchStore } from '@workbench/workbenchStore';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GalleryUiAdapterProvider } from './GalleryUiAdapter';

let store: ReturnType<typeof createWorkbenchStore>;
let adapter: GalleryUiAdapter;
const noop = () => undefined;

vi.mock('@features/gallery/react', () => ({
  GalleryUiProvider: ({ adapter: next, children }: { adapter: GalleryUiAdapter; children: ReactNode }) => {
    adapter = next;
    return children;
  },
}));
vi.mock('@features/queue/react', () => ({ useActiveProgressTarget: () => null }));
vi.mock('@workbench/projects/useProjectFileActions', () => ({ useExportLibraryProject: () => noop }));
vi.mock('@workbench/useOpenWorkbenchWidget', () => ({ useOpenWorkbenchWidget: () => noop }));
vi.mock('@workbench/WorkbenchContext', () => ({
  useActiveProjectSelector: (selector: (project: Project) => unknown) => selector(store.getSnapshot().activeProject),
  useWorkbenchCommands: () => store.commands,
  useWorkbenchQueries: () => store.queries,
}));

const renderAdapter = () => {
  renderToStaticMarkup(<GalleryUiAdapterProvider>{null}</GalleryUiAdapterProvider>);
  return adapter;
};
const values = (projectId: string) => getProjectWidgetValues(store.queries.getProject(projectId)!, 'gallery');

beforeEach(() => {
  accountLifecycle.activate('gallery-adapter-test');
  store = createWorkbenchStore();
});
afterEach(() => accountLifecycle.invalidate());

describe('Gallery settings adapter ownership', () => {
  it('updates the captured active project through the Gallery command', () => {
    const owner = renderAdapter();
    owner.gallery.updateSettings({ imageDensityPercent: 24, paginationMode: 'paginated' });

    expect(values(owner.projectId)).toMatchObject({ imageDensityPercent: 24, paginationMode: 'paginated' });
  });

  it('rejects a retained callback after switching projects and accepts the new project binding', () => {
    const first = renderAdapter();
    const firstValues = values(first.projectId);
    const secondProject = store.commands.projects.create();
    const secondValues = values(secondProject.id);

    first.gallery.updateSettings({ imageDensityPercent: 24 });
    expect(values(first.projectId)).toEqual(firstValues);
    expect(values(secondProject.id)).toEqual(secondValues);

    const second = renderAdapter();
    second.gallery.updateSettings({ imageDensityPercent: 12 });
    expect(values(secondProject.id).imageDensityPercent).toBe(12);
    expect(values(first.projectId)).toEqual(firstValues);
  });

  it('rejects retained callbacks after the account lifetime changes even with the same project id', () => {
    const previous = renderAdapter();
    const before = values(previous.projectId);
    accountLifecycle.activate('gallery-adapter-test');

    previous.gallery.updateSettings({ showImageDimensions: true });
    expect(values(previous.projectId)).toEqual(before);

    renderAdapter().gallery.updateSettings({ showImageDimensions: true });
    expect(values(previous.projectId).showImageDimensions).toBe(true);
  });
});
