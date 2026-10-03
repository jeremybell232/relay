// The camera: position plus zoom. screen = world * z + {x, y}; everything else
// is that identity rearranged. Ported from broadsheet's lib/canvas/camera.ts.

export const MIN_ZOOM = 0.05;
export const MAX_ZOOM = 4;

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

export function screenToWorld(cam, sx, sy) {
  return { x: (sx - cam.x) / cam.z, y: (sy - cam.y) / cam.z };
}

// No division by zoom: a screen-space drag moves the view the same distance at any zoom.
export function panBy(cam, dx, dy) {
  return { ...cam, x: cam.x + dx, y: cam.y + dy };
}

// Zoom about a viewport-local point; the point under the cursor stays under the cursor.
export function zoomAt(cam, px, py, factor) {
  const z = clamp(cam.z * factor, MIN_ZOOM, MAX_ZOOM);
  if (z === cam.z) return cam;
  const ratio = z / cam.z;
  return { z, x: px - (px - cam.x) * ratio, y: py - (py - cam.y) * ratio };
}

// `transform-origin: 0 0` is assumed.
export function worldTransform(cam) {
  return `translate(${cam.x}px, ${cam.y}px) scale(${cam.z})`;
}

export function zoomToBox(box, viewport, padding = 64) {
  const w = Math.max(1, viewport.width - padding * 2);
  const h = Math.max(1, viewport.height - padding * 2);
  const z = clamp(Math.min(w / box.w, h / box.h, 1), MIN_ZOOM, MAX_ZOOM);
  return {
    z,
    x: viewport.width / 2 - (box.x + box.w / 2) * z,
    y: viewport.height / 2 - (box.y + box.h / 2) * z,
  };
}

// Wheel deltas in pixels across browsers. Pinch arrives as ctrl+wheel; ⌘-wheel zooms on a mouse.
const LINE_HEIGHT = 16;
export function normalizeWheel(e, viewportHeight) {
  const unit = e.deltaMode === 1 ? LINE_HEIGHT : e.deltaMode === 2 ? viewportHeight : 1;
  let dx = e.deltaX * unit;
  let dy = e.deltaY * unit;
  if (e.shiftKey && dx === 0) {
    dx = dy;
    dy = 0;
  }
  return { dx, dy, isZoom: e.ctrlKey || e.metaKey };
}

// Exponential so in-then-out returns to the start; clamped so one hard flick can't jump levels.
const MAX_ZOOM_STEP = 12;
export function zoomFactor(dy) {
  return Math.exp(-clamp(dy, -MAX_ZOOM_STEP, MAX_ZOOM_STEP) * 0.01);
}
