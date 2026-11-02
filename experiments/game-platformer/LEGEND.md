# Drawing a level

A level is a plain `.excalidraw` file. Draw it on [excalidraw.com](https://excalidraw.com),
export it, and drop the file on the game. What an element does comes from
how it is drawn.

| Draw | It is |
|---|---|
| Gray or black rectangle, ellipse, diamond, line or freehand stroke | Ground. Lines and curves can be walked on up to 60 degrees. Steeper is a wall |
| The same with a dashed or dotted stroke | Ground you can jump up through. Down drops back through it |
| Anything red or pink | A hazard. Touching it sends you back to the last checkpoint |
| Amber or yellow ellipse | A coin |
| Amber or yellow diamond | A checkpoint |
| Green diamond | The goal |
| Blue rectangle | Water. Hold jump to swim up, and you leap out at the surface, so a bank can stand up to about 100 px above the water. Down dives |
| Blue ellipse, diamond or line | A spring. Hold jump as you land for a higher throw |
| An arrow that starts on a shape | Moves that shape along the arrow and back. Anything can ride: ground, hazards, coins, springs, the goal. Bound labels and grouped shapes go with it |
| An arrow that touches nothing | A sign |
| The word `start` | Where you begin. It only shows while editing |
| Other text, any other color, or anything under 50% opacity | Scenery. Green trees and faint clouds are safe to draw anywhere |

A fill wins over an outline, so a black outline with a red fill is a hazard.

The arrow's stroke width sets the speed: thin is slow, bold is normal, extra
bold is fast. Curved arrows work, and a straight arrow's line style is up to
you.

## Sizes

The player is 72 px tall, runs at 430 px a second, jumps 190 px high with jump
held and clears a gap of about 300 px at a run. A spring throws about 420 px
up. The view is 900 px tall. Excalidraw's default box is around 200 by 100,
so draw big.

## Keys

| Key | Does |
|---|---|
| Arrows, or WASD | Run, jump, drop. Space also jumps |
| R | Restart the page |
| E | Swap between playing and editing |
| 1 to 4, Enter | Pick a page, or go to the next after finishing |

In edit mode, drag anything, or drag the paper to pan. The wheel zooms. Del
removes the selected element, R reverts to the loaded drawing, and S saves
your changes as a new `.excalidraw` file. Hovering says what the game thinks
an element is. Press E and you are playing the change from the start.

## Rebuilding the shipped levels

`levels/*.excalidraw` are the source of truth and open in Excalidraw.
`tools/build-levels.mjs` only saved typing them. `tools/solve.mjs` searches for
keys that beat each level on the real simulation and writes `solutions/`, which
`tests/game-platformer.mjs` replays through the real keyboard. Run it again
after changing a level (`--coins` also checks that every coin can be reached).
