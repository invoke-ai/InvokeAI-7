import type { RegisteredWidget } from '@workbench/widgetContracts';

import { usePreloadOnIntentProps } from '@platform/react/usePreloadOnIntent';

export const useWidgetIntentPreloadProps = (widget: RegisteredWidget, disabled = false) =>
  usePreloadOnIntentProps(!disabled && widget.status === 'enabled' ? widget.implementation.preload : null);
