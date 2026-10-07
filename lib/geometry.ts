// Screenshot sizing. The model clicks in screenshot pixels; CDP input takes CSS
// pixels. We always send a screenshot in CSS pixels (so Retina 2x doesn't
// double every coordinate), capped to a box the docs recommend, and remember
// the scale so clicks map back.

export const MAX_SHOT = { width: 1600, height: 1000 };

export function shotScale(cssWidth: number, cssHeight: number, max = MAX_SHOT): number {
  return Math.min(1, max.width / cssWidth, max.height / cssHeight);
}

/**
 * Size of the screenshot sent to the model for a capture of imgWidth x imgHeight device pixels
 * of a page cssWidth CSS pixels wide: one pixel per CSS pixel, capped, and always the capture's
 * own shape. Forcing it to the viewport's shape would stretch the image whenever the two
 * disagree (viewport emulation, a resize mid-capture), and every click would land off target.
 */
export function shotSize(cssWidth: number, imgWidth: number, imgHeight: number, max = MAX_SHOT) {
  const cssHeight = (imgHeight * cssWidth) / imgWidth;
  const scale = shotScale(cssWidth, cssHeight, max);
  return { scale, width: Math.round(cssWidth * scale), height: Math.round(cssHeight * scale) };
}

/** Screenshot-space point -> CSS-pixel point. */
export function toCss(x: number, y: number, scale: number): { x: number; y: number } {
  return { x: Math.round(x / scale), y: Math.round(y / scale) };
}
