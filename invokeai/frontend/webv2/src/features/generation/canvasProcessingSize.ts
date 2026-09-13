/**
 * The canvas processing-size policy, on its own lazy interface: its only
 * consumers (the canvas graph compiler and the Generate form's canvas
 * section) load on demand, so it must not ride the eager `graph` entry into
 * the initial editor graph.
 */
export { resolveCanvasProcessingSize } from './core/canvas/canvasProcessingSize';
