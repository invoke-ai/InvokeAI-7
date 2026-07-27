import { createDeferredResource } from '@platform/state/deferredResource';

import type { WidgetImplementation, WidgetImplementationResource, WidgetTypeId } from './widgetContracts';

const validateImplementation = (widgetId: WidgetTypeId, value: WidgetImplementation): WidgetImplementation => {
  if (!value || typeof value !== 'object' || typeof value.view !== 'function') {
    throw new TypeError(`Widget ${widgetId} implementation must provide a view component.`);
  }

  return value;
};

/**
 * A widget's deferred implementation: the shared single-flight resource plus
 * the one thing that is specific to widgets, the view-component contract a
 * lazily imported module has to satisfy.
 */
export const createWidgetImplementationResource = (
  widgetId: WidgetTypeId,
  loader: () => Promise<WidgetImplementation>
): WidgetImplementationResource =>
  createDeferredResource(loader, (implementation) => validateImplementation(widgetId, implementation));
