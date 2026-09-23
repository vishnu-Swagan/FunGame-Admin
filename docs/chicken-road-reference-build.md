# Chicken Road reference build

## Scope and status

Rebuild the supplied slate-purple Chicken Road interface and manual lane-crossing
flow, with an isolated local visual preview and a separate server-authoritative
live implementation. The live implementation remains dormant until rules approval
and an explicit release. No customer balance or existing game rule is changed by
the dormant deployment.

- [x] Inspect the three screenshots and 18.19-second recording.
- [x] Audit the historical implementation before considering reuse.
- [x] Create a transparent chicken sprite from the supplied reference.
- [x] Implement the responsive road, coins, chicken animation, controls and dialogs.
- [x] Test safe hops, cashout, collision, replay, duplicate clicks and disabled controls.
- [x] Add matching blink artwork, articulated stepping legs, and coin-flip motion.
- [x] Add gesture-started walking/fire audio, mute persistence and background cleanup.
- [x] Recheck the recording's flame sequence and verify the updated effects in-browser.
- [x] Visually verify desktop rendering, stepping, cash-out, replay and collision.
- [x] Generate a matching gold/emerald/purple lobby logo and wire the game header.
- [x] Recheck compact mobile rendering after the shared-view extraction (390×844).
- [x] Complete independent code review and full frontend regression checks.
- [ ] Obtain operator approval of the proposed math before enabling wallet-backed play.

The reference shows a single full-width stage, a compact top bar, large multiplier
coins, a chicken anchored to the curb, and one horizontal control strip. Successful
lanes become gold, the current lane becomes green, and collision produces a red
flame coin and roast-chicken animation. The camera follows the chicken after the
second lane. Use the same controls on mobile without squeezing labels below
readable sizes. Respect reduced-motion preferences.

Computer-use browser access recovered. The local preview was exercised with
scripted credits only: a safe hop, cash-out, replay and collision all worked. The
updated 1.4-second collision burst visibly reaches the full road height. Flames
start inside the grills behind foreground bars and extend into the road, with
gradient cores, orange edges, wisps and embers. A confirmed safe crossing leaves
a finite departure flare behind the hopping chicken; a confirmed collision burns
the destination lane. Difficulty affects decorative intensity, never outcomes.
No production bet, payment or withdrawal was used for verification.

Final integration checks on 2026-09-23: 81 frontend suites / 641 tests passed;
the separate Aviator renderer passed 4 suites / 27 tests. The complete backend
run passed 561 tests / 987 subtests, followed by the final Chicken Road suite
with 73 tests / 843 subtests. The final general CLI review was clean. The
production build passed, and the compiled application contains none of the
local demo labels or scripted-model markers. Existing bundle-size and dependency
deprecation warnings remain; no unrelated dependency upgrade was attempted.

## Preview

Run `npm run preview:chicken-road` from `frontend` for the standalone local
preview at `http://127.0.0.1:4194/`. It uses existing build dependencies and serves
only the preview HTML, JS and sprite over loopback. Alternatively, run the existing
frontend development server, then open `/__preview/chicken-road`.
This development-only entry renders outside the
authentication provider; it imports no wallet or gameplay API. Production builds
do not register this preview route. The catalogue entry defaults to Coming Soon;
its logo can be published without activating unapproved odds.

All four difficulties are selectable in the local preview. Medium preserves the
captured labels; the other design-only ladders use the explicitly unapproved
proposal. Preview outcomes use documented fixed sequences, not random or certified
odds. Each fourth scripted round demonstrates full traversal. This is not evidence
of a live payout model. The recording does not establish real odds, the complete
provider ladder, or auto-play stopping rules.
See `chicken-road-rules-audit.md` before any real-money integration and
`chicken-road-live-rules-proposal.md` for an unapproved four-difficulty proposal.

The owner's requested publication contract is **live-only**: all four approved
difficulties, authenticated server-authoritative rounds and the existing wallet.
There must be no production demo selector, free-credit fallback, or locally
generated outcome when the API is unavailable. `LiveChickenRoadGame` is a separate
controller: only server responses may supply balances, ladders and outcomes.
The demo model stays outside the production import graph.

## Assets and design decisions

The main character asset is
`frontend/public/games/chicken-road/chicken-idle.png`. It was created with the
built-in image-generation tool using the second supplied screenshot as an edit
reference. The source image remains untouched. Animation is code-native, so the
sprite can idle and hop independently of the lane camera. Coins, grates, flames
and the small roast icon are resolution-independent SVG/CSS.

Prompt: Extract and recreate only the screenshot's white cartoon chicken on a
truly transparent background; preserve its plump white body, pale-blue shading,
large pale-yellow outlined eyes, red comb and wattle, orange-yellow open beak,
short golden legs, complete feet, and right-facing three-quarter pose. Remove UI,
text, coins, pavement, glow, shadow and background. No extra objects. Crisp 2D
cartoon game sprite, centered and suitable for code animation.

The UI uses scoped `--road-*` design tokens. Reference colours are slate road,
lavender inactive coins, green Play/GO/current coin and yellow Cash Out/passed
coins. The preview replaces unverified online/live-win statistics with truthful
demo labeling and uses credits rather than claiming withdrawable currency.

The blink variant `frontend/public/games/chicken-road/chicken-blink.png` was
created with the built-in image tool from the existing sprite. Final edit prompt:
change only the two eyes to gently shut cream-yellow eyelids with a curved dark
seam; preserve the exact body, pose, feet, wing, comb, beak, scale, position,
framing and transparent alpha. The original remains unchanged. Only the eye
regions of that variant are overlaid, avoiding body jumps during each blink.
Legs are separately clipped and articulated from the original sprite during
crossings, with a small body lean and landing compression.

Sound is locally synthesized Web Audio: three short footfalls, a quiet cluck,
and a finite whoosh/crackle/squawk on collision. No audio files, remote requests,
continuous loops or automatic playback on page load. Game-menu mute persists
when storage is available. Hidden tabs and unmount stop owned voices and cancel
late resume callbacks. Audio is decorative and never changes game outcomes.

The new `frontend/public/game-art/chicken-road.png` logo was generated with the
built-in image tool, using the existing Aviator, Pappu and Keno logos plus the
chicken sprite as references. Direction: an original transparent casino-game
badge; gold bevelled CHICKEN ROAD lettering, emerald plaque, purple medallion,
white cartoon chicken, road, multiplier coin and orange flames. Match the other
Chakri lobby badges without changing their source assets. The standard GameArt
component loads this canonical path and retains its existing image-error fallback.
