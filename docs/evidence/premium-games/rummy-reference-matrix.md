# Rummy visual-reference matrix

Reference manifest: `docs/references/rummy/approved-2026-08-21/reference-manifest.json` (`rummy-reference-2026-08-21-v1`).

The preserved screenshots define hierarchy and state flow only. Runtime art is original project-owned work; captured commerce/browser chrome, third-party identity, cash symbols, and device overlays are intentionally excluded. `RummyGame.js` serves the category lobby and authoritative table at `/games/rummy/play`; `RummyGame.test.js` covers private-seat rendering, the single timer, and safe-viewport sizing.

| Reference | Reference state | Implemented state and matched relationships | Premium modernisation | Intentional exclusions | Desktop | Mobile landscape | Mobile portrait | Status |
|---|---|---|---|---|---|---|---|---|
| `1000279341.png` | Five-category lobby | Exactly five centrally sourced LV1–LV5 cards; balance, entry, point value, turn duration, Live and labelled Practice joins | Emerald/walnut/brass category system and original 3D Rummy art | Cash symbols, store header, third-party brand | Capture pending | Capture pending | CSS contract tested | Implemented; capture pending |
| `1000279342.png` | Initial live table | Royal oval table; five fixed seats; local hand; adjacent closed/open piles; persistent wild joker; one active-seat timer | Original accessible cards, masked IDs, Chakri inlay, stable mounted stage | Faces, copied card backs, watermark/device chrome | Capture pending | Capture pending | CSS contract tested | Implemented; capture pending |
| `1000279343.png` | Drawn card and melds | Drawn card elevation, large lower hand, separated group containers, suggested group metadata | GPU transform elevation and compact responsive overlap | Repeated labels that cover card faces | Capture pending | Capture pending | CSS contract tested | Implemented; capture pending |
| `1000279345.png` | Manual selection | Button/tap selection, drag/drop placement, Group and Ungroup, selected-card elevation | Keyboard-focusable card buttons and high-contrast selected state | Captured pointer/device UI | Capture pending | Capture pending | CSS contract tested | Implemented; capture pending |
| `1000279346.png` | Turn guidance | Short live-region guidance, both legal draw targets, only active avatar countdown | Server-clock timer and disabled illegal targets | Duplicate countdowns and tutorial artwork in normal play | Capture pending | Capture pending | CSS contract tested | Implemented; capture pending |
| `1000279347.png` | Automatic grouping | Auto Sort remains client-only; server returns authoritative suggested groups and validation | Smooth regrouping without changing authoritative room version | Outcome-changing client sort | Capture pending | Capture pending | CSS contract tested | Implemented; capture pending |
| `1000279348.png` | Valid declaration | Declare is enabled only for an authoritative valid 13-card arrangement after discard | Gold declaration control and concise feedback | Winner overlays obscuring cards | Capture pending | Capture pending | CSS contract tested | Implemented; capture pending |
| `1000279349.png` | Table settlement | Server winner, point score, integer chip deltas, five ranked seats | Stable settlement overlay using final permitted reveal | Fiat notation and real-money implications | Capture pending | Capture pending | CSS contract tested | Implemented; capture pending |
| `1000279350.png` | Celebration | Bounded result sound/animation and authoritative win amount | Restrained motion; reduced-motion mode disables decorative loops | Device volume overlay and uncontrolled coin flood | Capture pending | Capture pending | CSS contract tested | Implemented; capture pending |
| `1000279351.png` | Results opening | Ranked rows, status, points, chip delta, final cards/groups | Scroll-safe modal and readable compact cards | Session/debug/version text | Capture pending | Capture pending | CSS contract tested | Implemented; capture pending |
| `1000279352.png` | Completed results | Final reveal, Back to Lobby, settlement reason and stable result state | Authoritative seed reveal after settlement | Third-party branding and cash copy | Capture pending | Capture pending | CSS contract tested | Implemented; capture pending |

## State evidence coverage

Implemented in the single route/state machine: category lobby; waiting/seat filling; initial 13-card hand; local turn; closed-deck draw; open-discard draw; manual grouping; Auto Sort; pure/impure sequence and set validation; invalid group/declaration; first/middle drop; declare; settlement; bounded celebration; final results; reconnect overlay with the table kept mounted. Automated rule/component evidence is recorded in `test-report.md`.

Visual captures were not fabricated. Real-device desktop, landscape, portrait, and five-client reconnect captures remain a release evidence gate.
