// A slide activity makes the room part of the talk. A slide declares one in its
// `activity`. The server owns its state, each phone gets a controller for it, and
// the shared screen draws it.
//
// On the server an activity is a class constructed with (slide, host):
//
//   static tickHz, frameHz, youHz   how often tick, frame and you run. All optional.
//   join(id), leave(id)             a phone arrives or drops. It may come back with the same id.
//   input(id, msg)                  fast input that may be lost. Sent as {t:'act', ...} without a number.
//   submit(id, op)                  phone input that must arrive. Returns a result for the phone.
//   review(op)                      a presenter's decision. Returns whether it was allowed.
//   setStep(step)                   the presenter moved within the slide
//   layout()                        the presenter's ink or offsets on this slide changed
//   tick(dt)                        advance by dt seconds. Runs only while this is the current slide.
//   frame()                         what screens draw, or null if nothing changed
//   you(id)                         what this one phone needs
//
// The host gives an activity {state, log, emit(op), toPresenter(op)}. Ops sent with
// emit reach every screen and the replay log. Anything sent to the presenter alone,
// such as an unmoderated drawing, can never appear on a shared screen or in a replay.
//
// In the browser a kind is described by an object in views.js.

import { Race } from './race.js';
import { QueueActivity } from './queue.js';
import { Gallery } from './gallery.js';
import { TalkLog } from './talk-log.js';

const KINDS = { race: Race, queue: QueueActivity, gallery: Gallery, log: TalkLog };

export const createActivity = (slide, host) => new KINDS[slide.activity.kind](slide, host);
