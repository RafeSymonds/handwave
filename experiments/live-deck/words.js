// Text layout shared by the slides and the phone.

import { measure } from '/lib/stage.js';

/** Break words into lines that fit a width. A word too long for a line is split. */
export function wrap(words, width, size, font = 5) {
  const lines = [];
  let current = '';
  const fits = (s) => measure(s, size, font).width <= width;
  for (let word of String(words).split(/\s+/).filter(Boolean)) {
    while (!fits(word)) {
      let cut = word.length - 1;
      while (cut > 1 && !fits((current ? `${current} ` : '') + word.slice(0, cut))) cut--;
      lines.push((current ? `${current} ` : '') + word.slice(0, cut));
      current = '';
      word = word.slice(cut);
    }
    const next = current ? `${current} ${word}` : word;
    if (fits(next)) current = next;
    else { lines.push(current); current = word; }
  }
  if (current) lines.push(current);
  return lines.join('\n');
}
