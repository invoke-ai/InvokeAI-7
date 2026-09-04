import type { CanvasEngineHandle } from '@workbench/widgets/canvas/useCanvasEngine';

import { useEffect } from 'react';

import { useActiveColorCommands, useActiveColorPair } from './useActiveColors';

/**
 * The bridge between the active color pair and one engine, kept out of the
 * canvas widget shell so per-pointermove pair edits (chip drags, eyedropper
 * scrubs) re-render only this null component:
 *
 * - the pair owns painting color, and the engine's brush color is its mirror
 *   (the legacy field kept as a compatibility adapter), fed one-directionally
 *   like the view settings — strokes capture the color at gesture start, so a
 *   mid-stroke pair change cannot recolor half an edit;
 * - unclaimed eyedropper samples route to the active foreground/background
 *   target instead of the brush option.
 */
export const CanvasColorFeed = ({ engine }: { engine: CanvasEngineHandle | null }) => {
  const colorPair = useActiveColorPair();
  const colorCommands = useActiveColorCommands();

  useEffect(() => {
    if (!engine) {
      return;
    }
    const options = engine.interaction.get('brushOptions');
    if (options.color !== colorPair.foreground) {
      engine.interaction.set('brushOptions', { ...options, color: colorPair.foreground });
    }
  }, [engine, colorPair.foreground]);

  // The whole pair, for gesture-start reads: new shapes and text sessions
  // capture it when they begin, and the gradient FG→BG preset resolves it.
  useEffect(() => {
    if (!engine) {
      return;
    }
    engine.interaction.set('colorPair', { background: colorPair.background, foreground: colorPair.foreground });
  }, [engine, colorPair.background, colorPair.foreground]);

  useEffect(() => {
    if (!engine) {
      return;
    }
    return engine.tools.setColorSampleRouter((hex) => {
      colorCommands.applySampledColor(hex);
      return true;
    });
  }, [colorCommands, engine]);

  return null;
};
