import { registerAccountOwnedResource } from '@platform/state/accountLifecycle';
import { createExternalStore } from '@platform/state/externalStore';

/**
 * The Color pane's one non-pair target: a mask layer's tint, armed explicitly
 * from a compatible Layer property or the pane's own chip. Transient by
 * design — the tint itself is document state; this only names which layer the
 * pane is currently editing. Cleared whenever the armed layer stops being the
 * selected mask, so the pane falls back to the foreground/background target.
 */
export const maskTintTargetStore = createExternalStore<{ layerId: string | null }>({ layerId: null });

registerAccountOwnedResource({
  clear: () => {
    maskTintTargetStore.setSnapshot({ layerId: null });
  },
  name: 'mask-tint-target',
});

export const armMaskTintTarget = (layerId: string): void => {
  maskTintTargetStore.setSnapshot({ layerId });
};

export const clearMaskTintTarget = (): void => {
  if (maskTintTargetStore.getSnapshot().layerId !== null) {
    maskTintTargetStore.setSnapshot({ layerId: null });
  }
};

export const useMaskTintTargetLayerId = (): string | null =>
  maskTintTargetStore.useSelector((snapshot) => snapshot.layerId, Object.is);
