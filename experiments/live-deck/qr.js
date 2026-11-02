// The join address as a QR code. It is drawn once in the hand-drawn style and kept
// as one image, so it appears all at once and moves like any other element. Rows
// come from the server, which knows the address. Each run of dark modules is one
// rough bar with a small offset, and error correction covers what that costs.

import { drawElement } from '/lib/render.js';
import { rect, color } from '/lib/draw.js';

const MODULE = 20;
const QUIET = 4;   // The blank margin scanners require, in modules.

export const QR_FILE = 'join-qr';

export function qrDataUrl(rows) {
  const n = rows.length;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = (n + QUIET * 2) * MODULE;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  rows.forEach((row, y) => {
    for (let x = 0; x < n; x++) {
      if (row[x] !== '1') continue;
      let end = x;
      while (row[end + 1] === '1') end++;
      drawElement(ctx, rect(`qr-${y}-${x}`, (x + QUIET) * MODULE, (y + QUIET) * MODULE, (end - x + 1) * MODULE, MODULE, {
        backgroundColor: color.ink, strokeColor: color.ink, strokeWidth: 1, roughness: 0.6, roundness: null,
      }));
      x = end;
    }
  });
  return canvas.toDataURL('image/png');
}

/** The code as a scene element. It needs `stage.files[QR_FILE]` to be set. */
export const qrElement = (id, x, y, size) => ({
  ...rect(id, x, y, size, size, { strokeColor: 'transparent', roundness: null }),
  type: 'image',
  fileId: QR_FILE,
  customData: { handwave: { enter: 'fade', seconds: 0.25 } },
});
