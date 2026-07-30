# Fun Roulette — the table engine

`engine.js` is the game itself: the rectified overhead wheel, the ball physics,
the layout, the racetrack, statistics, favourites, autoplay and the spoken call.
It is imperative DOM code rather than React components, on purpose — it places
every chip, anchor and racetrack point by measuring real element rectangles
against the exact markup in `markup.js`, and re-expressing that as JSX would fork
the markup from the code already tested against it.

**The engine is not authoritative.** It never draws a winner, never moves the
balance on its own account and never settles a bet. `RouletteGame.js` polls
`/games/fun-roulette/state` and calls `applyState()`; taps come back out through
`onPlaceBet` / `onUndo` and are posted to the API. A refused bet simply
disappears on the next poll, because the chips on the felt are rendered from the
server's own record of them.

## Regenerating

`styles.css` and `markup.js` are generated from the standalone build. Every CSS
selector is scoped under `.rvip` and every `@keyframes` name is namespaced,
because the standalone version styles `:root`, `body` and generic names like
`.cell`, `.board` and `.toast` that would otherwise restyle the rest of the app.

## Wheel assets

`public/game-art/roulette/wheel-{head,bowl}.webp` are the two layers of the
overhead wheel: the head turns, the bowl (apron, deflectors, cabinet) does not.
They are produced by `finish_wheel.py`, which rectifies the original 3/4
photograph into a true overhead circle and repaints the number ring in the
American order. `felt.webp` lives next to `styles.css` so webpack bundles it —
an absolute `/public` path in a CSS `url()` is treated as a module request and
fails to resolve.
