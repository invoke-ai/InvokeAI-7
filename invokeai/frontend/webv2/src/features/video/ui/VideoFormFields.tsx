import type { GenerateLora, MainModelConfig, PromptHistoryItem } from '@features/generation/contracts';
import type { VideoWidgetValues } from '@features/video/core/types';

import { Stack } from '@chakra-ui/react';
import { NegativePromptField, PositivePromptField } from '@features/generation/components';
import { memo, useCallback } from 'react';

import { areVideoLorasEquivalent, areVideoModelsEquivalent } from './videoComparators';

/**
 * The Video widget's prompt block. The prompt is Video's own widget value, not
 * the project draft Generate and Upscale share: a video prompt describes motion
 * over time and has nothing useful to say to an image model, so the two panels
 * hold independent text. Memoised against content: the widget re-derives
 * `values` on every patch and the prompt editors carry autocomplete state a
 * needless remount would disturb.
 */
export const VideoPromptFields = memo(
  function VideoPromptFields({
    loras,
    model,
    negativeHelpText,
    negativePrompt,
    negativePromptEnabled,
    negativePromptHeightPx,
    negativeVisible,
    onPatchValues,
    positivePrompt,
    positivePromptHeightPx,
    projectId,
    showSyntaxHighlighting,
  }: {
    loras: GenerateLora[];
    model: MainModelConfig | null;
    negativeHelpText?: string;
    negativePrompt: string;
    negativePromptEnabled: boolean;
    negativePromptHeightPx: number;
    /** From the video prompt policy: MiniMax H3 has no negative conditioning at all. */
    negativeVisible: boolean;
    onPatchValues: (patch: Partial<VideoWidgetValues>) => void;
    positivePrompt: string;
    positivePromptHeightPx: number;
    projectId: string;
    showSyntaxHighlighting: boolean;
  }) {
    const handleUsePrompt = useCallback(
      (prompt: PromptHistoryItem) =>
        onPatchValues({
          negativePrompt: prompt.negativePrompt ?? '',
          negativePromptEnabled: prompt.negativePrompt ? true : negativePromptEnabled,
          positivePrompt: prompt.positivePrompt,
        }),
      [negativePromptEnabled, onPatchValues]
    );
    const handlePositiveChange = useCallback(
      (nextPositivePrompt: string) => onPatchValues({ positivePrompt: nextPositivePrompt }),
      [onPatchValues]
    );
    const handleNegativeChange = useCallback(
      (nextNegativePrompt: string) => onPatchValues({ negativePrompt: nextNegativePrompt }),
      [onPatchValues]
    );
    const handleNegativeEnabledChange = useCallback(
      (nextNegativePromptEnabled: boolean) => onPatchValues({ negativePromptEnabled: nextNegativePromptEnabled }),
      [onPatchValues]
    );
    const handlePositiveResizeEnd = useCallback(
      (positivePromptHeight: number) => onPatchValues({ positivePromptHeightPx: positivePromptHeight }),
      [onPatchValues]
    );
    const handleNegativeResizeEnd = useCallback(
      (negativePromptHeight: number) => onPatchValues({ negativePromptHeightPx: negativePromptHeight }),
      [onPatchValues]
    );

    return (
      <Stack gap="2" p="2">
        <PositivePromptField
          heightPx={positivePromptHeightPx}
          loras={loras}
          projectId={projectId}
          selectedModel={model ?? undefined}
          showSyntaxHighlighting={showSyntaxHighlighting}
          value={positivePrompt}
          onChange={handlePositiveChange}
          onResizeEnd={handlePositiveResizeEnd}
          onUsePrompt={handleUsePrompt}
        />
        {negativeVisible ? (
          <NegativePromptField
            heightPx={negativePromptHeightPx}
            helpText={negativeHelpText}
            isEnabled={negativePromptEnabled}
            loras={loras}
            projectId={projectId}
            selectedModel={model ?? undefined}
            showSyntaxHighlighting={showSyntaxHighlighting}
            value={negativePrompt}
            onChange={handleNegativeChange}
            onEnabledChange={handleNegativeEnabledChange}
            onResizeEnd={handleNegativeResizeEnd}
          />
        ) : null}
      </Stack>
    );
  },
  (previous, next) =>
    previous.negativePrompt === next.negativePrompt &&
    previous.negativePromptEnabled === next.negativePromptEnabled &&
    previous.negativePromptHeightPx === next.negativePromptHeightPx &&
    previous.negativeVisible === next.negativeVisible &&
    previous.negativeHelpText === next.negativeHelpText &&
    previous.onPatchValues === next.onPatchValues &&
    previous.positivePrompt === next.positivePrompt &&
    previous.positivePromptHeightPx === next.positivePromptHeightPx &&
    previous.projectId === next.projectId &&
    previous.showSyntaxHighlighting === next.showSyntaxHighlighting &&
    areVideoModelsEquivalent(previous.model, next.model) &&
    areVideoLorasEquivalent(previous.loras, next.loras)
);
