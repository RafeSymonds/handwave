# Runnable diagrams

The drawing is the program. Draw a diagram in Excalidraw, save it, and drop the
file on this page. `graph.js` reads the program out of the drawing, with no other
file involved.

## What a drawing means

A drawing with a `rate` or `workers` label runs as a flow of work:

| Draw | It does |
|---|---|
| A shape labelled `rate 3/s` | Makes work at that average rate |
| A shape labelled `workers 3`, `takes 0.75s` | Does work, 3 jobs at a time, about 0.75s each |
| A shape with arrows in but none out | Ends work and counts it |
| A diamond | Splits work by `90%` and `10%` labels on its arrows, or evenly |
| Any other shape | Holds work until the next shape has room. `limit 20` turns work away past 20 |

Any other drawing with arrows runs as a state machine:

| Draw | It does |
|---|---|
| A shape | A state |
| An arrow from nothing to a shape | Marks the first state. Without one, the first shape nothing points to |
| An arrow labelled `fail` | Moves on the `fail` event. Each event gets a button and a number key |
| An arrow labelled `fail x3` | Moves on the third `fail` in a row. Any other event starts the count again |
| An arrow labelled `after 5s` | Moves by itself after 5 seconds in the state |
| An arrow with no label | Moves on an event called `next` |

Free text inside a shape or beside an arrow counts as its label, and arrows that
stop near a shape count as bound to it, so a scene placed by hand also runs. Text
anywhere else is a note and does nothing.

## On the page

Drag a shape, and its label and arrows follow. Drag an arrow's end onto another
shape to rewire it, or let go over nothing to put it back. Double-click a label to
change it: Enter saves, Shift+Enter adds a line, Escape cancels. The program keeps
running through all of this, and what is in progress carries over.

## Files

| Path | What |
|---|---|
| `graph.js` | Drawing to program. No DOM |
| `sim.js` | Runs a program on a fixed step with a seeded random generator. No DOM |
| `edit.js` | Moves, rewires and relabels, keeping the file native Excalidraw |
| `main.js` | The screen and input |
| `scenes/make.mjs` | Writes `queue.excalidraw` and `breaker.excalidraw` |
| `scenes/from-excalidraw.excalidraw` | A test file made by Excalidraw's own converter |

`node tests/machine.mjs` drives all of this in a real browser.
