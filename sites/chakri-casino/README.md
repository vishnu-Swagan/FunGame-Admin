# Chakri.Casino marketing GameCard (Cursor Sites)

Live `https://chakri.casino` is the Vinext / Cursor Sites Next.js app (`ChakriSite`), not the React lobby in `frontend/src/components/GameCard.js`. `play.chakri.casino` has no DNS. This folder is the patch for the cards the logged-out homepage actually renders.

## Live markup (verified 4 Sep 2026)

Ready card: `article.game-card` → `div.game-visual` + `span.game-status-badge.active` READY → `a.play-button` href `/games/{slug}/play` aria-label `Open {name}` with a circular gold ArrowRight only.

Coming Soon: same card, `span.play-button.is-disabled` + PauseCircle. No link.

Hero: `a.button.button-primary` href `/casino` labelled `Play now` with no loop.

## Apply in the Cursor Sites / Vinext project that publishes chakri.casino

FunGame-Admin cannot deploy the apex homepage. Open that Sites project and:

1. Replace GameCard (`function Wm`) with `GameCard.jsx`. Keep GameVisual (`Um`) as-is.
2. Wrap the hero primary button children with `HeroPlayNow.jsx`.
3. Append `play-now.css` to the site stylesheet (after the existing `.play-button` rules).
4. Publish. Do not point apex DNS at Render.

Until that publish, appending `play-now.css` alone still turns the live circular `<a class="play-button">` into a PLAY NOW pill, loops text + arrow, and stretches the existing play link across the card. Coming Soon spans stay disabled circles.

## Login gate

Ready cards keep `href="/games/{slug}/play"`. That path is reverse-proxied to the FunGame-Admin player app, where `RequireAuth` already sends guests to login/create account. Do not retarget these cards at `/casino`.
