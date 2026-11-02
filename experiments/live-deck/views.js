// How each activity kind looks in the browser. A view is an object with:
//
//   slide(step, ctx)          the slide's elements on the shared screen
//   sceneKey(frame)           optional: redraw the slide only when this string changes
//   drawEveryFrame            redraw the slide on every frame from the server
//   startScreen(stage, opts)  optional: continuous drawing, with frame(f) and stop()
//   startPhone(ctx)           the phone's controller: elements(), you(data), stop()
//   panel, panelKey, key      optional: the presenter's controls and keys

import { galleryView } from './gallery-view.js';
import { logView } from './log-view.js';
import { queueView } from './queue-view.js';
import { raceView } from './race-view.js';

export const VIEWS_OF_KIND = { race: raceView, queue: queueView, gallery: galleryView, log: logView };
export const viewOf = (slide) => (slide.activity ? VIEWS_OF_KIND[slide.activity.kind] : null);
