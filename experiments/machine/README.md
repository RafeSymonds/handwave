# Runnable diagrams

The drawing is the program. Draw a diagram here or in Excalidraw and it runs: shapes
are parts, arrows join them, and labels say what they do. A saved drawing is a plain
`.excalidraw` file, so everything about the program lives in shapes and text you can
type in Excalidraw.

## What is on the page

| Where | What |
|---|---|
| Left | Parts to drag on. Drop one on an arrow to put it in line. Hover one to read about it |
| Middle | The board, and a panel saying what the program is doing |
| Right | What the program thinks the shape under the pointer is, why, which words it understood, and what else it could say |
| Top | Pause, step, speed, restart, undo, redo, save, open, what if, and the reference |

A misspelled or misplaced word gets a line under it and a message on the drawing, with
a fix to click. Hints appear as you type a label. **What can I draw?** is the reference,
and is built from the table the parser reads, as are the hints and the inspector's
lists. A test checks that every word in the table parses from its own example.

The page opens on a gallery of 14 demos. Each one claims something you can test by
changing the drawing.

| Demo | What it shows | Try |
|---|---|---|
| `queue` | Work piles up when it arrives faster than workers finish | Kill a worker |
| `lines` | One shared line beats one line per worker | Watch the chart |
| `storm` | Retries keep a system down after the spike has gone | Change `copy after 5s` to `after 5s` |
| `cache` | Empty the cache and the database falls behind | Press "empty the cache" |
| `fanout` | Fan-out makes rare slowness common | Compare `split 8` |
| `balance` | Taking turns keeps feeding a dead worker | Kill a row, then write `least busy` |
| `batch` | There is a best batch size, and it isn't the biggest | Compare `batch 4` |
| `priority` | A priority lane lets other work wait forever | Delete `priority gold` |
| `limit` | A rate limit keeps the line short by saying no | Delete its label |
| `breaker` | A circuit breaker stops calling a failing service | Press 1 three times |
| `backoff` | Guards, counters and doubling waits, written on arrows | Press fail repeatedly |
| `weather` | Where you start stops mattering | Drag the start arrow |
| `latch` | Two gates that feed each other remember | Turn set on and off |
| `counter` | Chained flip-flops count in binary | Watch the timing chart |

## What a drawing means

The words decide how a drawing runs. A word in a label can go in any order, and the
reference says which few must be alone on their line. Anything else in a label is a name.

**A flow of work**, when a shape uses a word such as `rate 3/s`, `workers 3`, `delay 2s`,
`batch 5 or 2s`, `cache 80%` or `rate limit 5/s`. Tokens travel along arrows. A diamond
chooses between its arrows. A shape with arrows in and none out ends work and counts it.
Any other shape holds work until the next shape has room.

| Shape word | Does |
|---|---|
| `rate 3/s`, `steady`, `burst 40 at 10s`, `mix gold 20%`, `keys 1000` | Makes work |
| `workers 3`, `takes 0.75s`, `slow 5% x10` | Does work. Click a worker's box to kill it |
| `limit 20`, `priority gold` | Limits and orders a line |
| `delay 2s` | Holds every job that long, with no limit on how many |
| `batch 5 or 2s` | Groups jobs into one |
| `split 3`, `merge`, `first 1` | Splits a job into parts, then waits for all of them or the first few |
| `cache 80%` | A fixed hit rate. `cache 200` remembers 200 items, so its hit rate is earned |
| `rate limit 5/s` | Lets this much through |
| `round robin`, `random`, `least busy`, `two choices` | How a shape picks an arrow |

| Arrow word | Does |
|---|---|
| `90%` | This share takes this arrow |
| `if retries < 3`, `else` | Only matching work takes it. Work knows `retries`, `age` and its mix name |
| `after 5s` | Work that has waited this long leaves this way |
| `copy after 5s` | A retry leaves this way while the original keeps waiting, drawn gray |
| `hit`, `miss`, `over` | Where a cache or rate limit sends work |

**A logic circuit**, when a whole label line says `switch`, `button`, `clock 1s`, `and`,
`or`, `not`, `xor`, `nand`, `nor`, `flip` or `lamp`. Arrows carry a 1 or a 0, and changes
take time to travel, so a latch holds and a ring of `not` gates oscillates.

**A chance walk**, when arrows carry % labels and none of the above applies. Walkers
stand on shapes and take arrows by their shares. An arrow from nothing can say `start 200`
and `every 1s`.

**A state machine**, for any other drawing with arrows. Arrow words:

| Write | Does |
|---|---|
| `fail` | Any other words are an event, with a button and a number key |
| `fail x3` | Moves on the third `fail` in a row |
| `after 5s` | Moves by itself after that time. `after wait` reads a variable |
| `buy [money >= 75]` | A guard. A guard alone moves as soon as it is true |
| `coin / money = money + 25` | An action, run when the arrow fires |
| `enter tries = 0` | On a shape: runs each time the state is entered |

Guards and actions use a small parser in `expr.js`, with no `eval`. A drawing can only do
arithmetic, comparisons and logic on its own names.

**In any drawing**, `chart` draws a live chart, of whatever an arrow joins it to. Nothing
travels along that arrow. `chart waiting + busy` chooses what it shows, and in a state
machine `chart tries` charts a variable. Other text is a note and does nothing.

## What if

**What if?** runs the drawing forward 40 times with different seeds in a worker and draws
every run. **Compare**, beside any number in the inspector, runs it at a range of values
and shows the spread at each. Click a column to use that value. Both give the same answer
for the same drawing.

## Files

| Path | What |
|---|---|
| `vocab.js` | Every word, kind and part, in one table, and the label parser. No DOM |
| `expr.js` | The expression parser. No DOM |
| `graph.js` | Drawing to program, and what to say about mistakes. No DOM |
| `sim.js` | Runs a program on a fixed step with a seeded random generator. No DOM |
| `edit.js` | Adds, moves, rewires, relabels and deletes, keeping the file native Excalidraw |
| `whatif.worker.js` | Runs many seeded futures away from the page |
| `main.js` | State and input |
| `overlay.js` | Draws the running program over the drawing |
| `panel.js` | The panel under the board |
| `ui.js` | The inspector, reference, gallery, hints and what-if charts |
| `scenes/make.mjs` | Writes the demo drawings and `scenes/demos.json` |
| `scenes/from-excalidraw.excalidraw` | A test file made by Excalidraw's own converter |

`node tests/machine.mjs` drives all of this in a real browser with real mouse, keyboard and
touch input.

## What does not work yet

- Phones. Touch is tested on a 1024x768 tablet. At 390 wide the page fits with no page
  scroll, but a full-size demo is too small to read and there is no pan or zoom.
- A selection of more than one shape, copy and paste between drawings, and changing a
  shape's type or color on the page. Do those in Excalidraw.
- Elbow arrows, frames and groups from Excalidraw are untested on the page.
- Killed workers and switch positions are part of a run, not the drawing, so they are not saved.
