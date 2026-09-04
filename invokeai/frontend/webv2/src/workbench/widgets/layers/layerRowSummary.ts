import type { CanvasLayerContract } from '@workbench/canvas-engine/api';
import type { TFunction } from 'i18next';

/**
 * The row's secondary line: what this layer contributes, from data the layer already carries. A
 * raster names its source and any non-default blend or opacity; a control layer its adapter and
 * weight; regional guidance its prompt or reference images; an inpaint mask its denoise bounds.
 */
export const layerRowSummary = (layer: CanvasLayerContract, t: TFunction): string => {
  switch (layer.type) {
    case 'raster': {
      const parts = [t(`widgets.layers.types.${layer.source.type === 'image' ? 'image' : layer.source.type}`)];
      if (layer.blendMode !== 'normal') {
        parts.push(t(`widgets.layers.blendModes.${layer.blendMode}`));
      }
      if (layer.opacity < 1) {
        parts.push(`${Math.round(layer.opacity * 100)}%`);
      }
      return parts.join(' · ');
    }
    case 'control':
      return `${t(`widgets.layers.control.kinds.${layer.adapter.kind}`)} · ${layer.adapter.weight.toFixed(2)}`;
    case 'regional_guidance': {
      const prompt = layer.positivePrompt?.trim();
      if (prompt) {
        return prompt;
      }
      const references = layer.referenceImages.length;
      return references > 0
        ? t('widgets.layers.summary.referenceImages', { count: references })
        : t('widgets.layers.types.regional_guidance');
    }
    case 'inpaint_mask': {
      const parts = [t('widgets.layers.types.inpaint_mask')];
      if (layer.denoise?.isEnabled) {
        parts.push(t('widgets.layers.summary.denoiseLimit', { value: Math.round(layer.denoise.limit * 100) }));
      }
      if (layer.noise?.isEnabled && layer.noise.level > 0) {
        parts.push(t('widgets.layers.summary.noise', { value: Math.round(layer.noise.level * 100) }));
      }
      return parts.join(' · ');
    }
  }
};
