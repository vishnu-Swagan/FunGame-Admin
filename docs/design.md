---
version: alpha
name: Chakri Live Andar Bahar
description: A cinematic table-native Andar Bahar design system centered on a royal card reveal while remaining precise on every screen.
colors:
  navy: "#11162F"
  navy-raised: "#1B2242"
  navy-deep: "#080C1D"
  table-gold: "#C7A55D"
  metal-gold: "#E4C06B"
  metal-gold-deep: "#79551D"
  andar: "#E3153B"
  bahar: "#2857A5"
  ivory: "#F8F1DF"
  muted: "#A8B0CC"
  success: "#42C477"
  warning: "#F2C65D"
  error: "#F0545F"
typography:
  display:
    fontFamily: Inter, Avenir Next, Segoe UI, sans-serif
    fontSize: 28px
    fontWeight: 800
    lineHeight: 1.05
    letterSpacing: -0.02em
  heading:
    fontFamily: Inter, Avenir Next, Segoe UI, sans-serif
    fontSize: 18px
    fontWeight: 800
    lineHeight: 1.15
  body:
    fontFamily: Inter, Avenir Next, Segoe UI, sans-serif
    fontSize: 14px
    fontWeight: 600
    lineHeight: 1.3
  label:
    fontFamily: Inter, Avenir Next, Segoe UI, sans-serif
    fontSize: 12px
    fontWeight: 800
    lineHeight: 1
    letterSpacing: 0.03em
  caption:
    fontFamily: Inter, Avenir Next, Segoe UI, sans-serif
    fontSize: 10px
    fontWeight: 700
    lineHeight: 1.1
  numeric:
    fontFamily: Inter, Avenir Next, Segoe UI, sans-serif
    fontSize: 16px
    fontWeight: 800
    lineHeight: 1
    fontFeature: tabular-nums
rounded:
  xs: 2px
  sm: 6px
  md: 10px
  lg: 24px
  stage: 34px
  pill: 999px
spacing:
  1: 2px
  2: 4px
  3: 8px
  4: 12px
  5: 16px
  6: 24px
components:
  royal-reveal-stage:
    backgroundColor: "{colors.navy-deep}"
    rounded: "{rounded.stage}"
    padding: "{spacing.5}"
    width: 1072px
    height: 410px
  andar-lane:
    backgroundColor: "{colors.andar}"
    textColor: "{colors.ivory}"
    typography: "{typography.label}"
    rounded: "{rounded.lg}"
    width: 790px
    height: 132px
  bahar-lane:
    backgroundColor: "{colors.bahar}"
    textColor: "{colors.ivory}"
    typography: "{typography.label}"
    rounded: "{rounded.lg}"
    width: 790px
    height: 132px
  dealt-card:
    backgroundColor: "{colors.ivory}"
    textColor: "{colors.navy-deep}"
    typography: "{typography.heading}"
    rounded: "{rounded.sm}"
    width: 68px
    height: 96px
  dealt-card-winning:
    backgroundColor: "{colors.ivory}"
    textColor: "{colors.navy-deep}"
    typography: "{typography.heading}"
    rounded: "{rounded.sm}"
    width: 68px
    height: 96px
  joker-card:
    backgroundColor: "{colors.ivory}"
    textColor: "{colors.navy-deep}"
    typography: "{typography.heading}"
    rounded: "{rounded.sm}"
    width: 78px
    height: 110px
  joker-pedestal:
    backgroundColor: "{colors.navy-deep}"
    textColor: "{colors.metal-gold}"
    typography: "{typography.caption}"
    rounded: "{rounded.lg}"
    width: 140px
    height: 252px
  phase-ribbon:
    backgroundColor: "{colors.navy-raised}"
    textColor: "{colors.ivory}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "{spacing.3}"
    height: 34px
  result-banner-andar:
    backgroundColor: "{colors.andar}"
    textColor: "{colors.ivory}"
    typography: "{typography.heading}"
    rounded: "{rounded.md}"
    padding: "{spacing.3}"
    height: 58px
  result-banner-bahar:
    backgroundColor: "{colors.bahar}"
    textColor: "{colors.ivory}"
    typography: "{typography.heading}"
    rounded: "{rounded.md}"
    padding: "{spacing.3}"
    height: 58px
  side-bet-andar:
    backgroundColor: "{colors.andar}"
    textColor: "{colors.ivory}"
    typography: "{typography.heading}"
    rounded: "{rounded.sm}"
    padding: "{spacing.4}"
    height: 140px
  side-bet-bahar:
    backgroundColor: "{colors.bahar}"
    textColor: "{colors.ivory}"
    typography: "{typography.heading}"
    rounded: "{rounded.sm}"
    padding: "{spacing.4}"
    height: 140px
  side-bet-selected:
    backgroundColor: "{colors.metal-gold}"
    textColor: "{colors.navy-deep}"
    typography: "{typography.numeric}"
    rounded: "{rounded.pill}"
    padding: "{spacing.2}"
    size: 42px
  count-bet:
    backgroundColor: "{colors.navy-deep}"
    textColor: "{colors.metal-gold}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "{spacing.3}"
    height: 65px
  count-bet-winning:
    backgroundColor: "{colors.table-gold}"
    textColor: "{colors.ivory}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "{spacing.3}"
    height: 65px
  chip:
    backgroundColor: "{colors.navy-raised}"
    textColor: "{colors.ivory}"
    typography: "{typography.numeric}"
    rounded: "{rounded.pill}"
    size: 52px
  chip-selected:
    backgroundColor: "{colors.table-gold}"
    textColor: "{colors.navy-deep}"
    typography: "{typography.numeric}"
    rounded: "{rounded.pill}"
    size: 58px
  roadmap-dot-andar:
    backgroundColor: "{colors.andar}"
    textColor: "{colors.ivory}"
    typography: "{typography.caption}"
    rounded: "{rounded.pill}"
    size: 19px
  roadmap-dot-bahar:
    backgroundColor: "{colors.bahar}"
    textColor: "{colors.ivory}"
    typography: "{typography.caption}"
    rounded: "{rounded.pill}"
    size: 19px
  account-bar:
    backgroundColor: "{colors.navy}"
    textColor: "{colors.muted}"
    typography: "{typography.body}"
    rounded: "{rounded.xs}"
    padding: "{spacing.4}"
    height: 34px
---

# Chakri Live Andar Bahar Design System

## Overview
This system presents a cinematic, table-native Andar Bahar experience for adult Chakri.Casino play-chip users on desktop, tablet, and mobile. The north star is a tactile royal card reveal built into the existing table, with the felt and cards carrying the spectacle. It must never drift into a generic neon casino mockup or a cartoon card game. This is a presentation-only refinement: game rules, odds, wagering states, settlement behavior, APIs, and server behavior remain unchanged.

## Colors
Midnight navy is the structural surface because it lets the warm felt and central reveal stage remain dominant. Crimson is reserved for Andar and royal blue for Bahar, giving each centered dealing lane an unmistakable edge, label, and landing cue without flooding the felt. Champagne and metallic gold connect the table, odds, selected chips, stage frame, and focus states; ivory is the essential text color. All actionable text maintains AA-level contrast at its rendered size.

## Typography
Inter or the closest installed humanist-geometric sans is used throughout to match the compact broadcast interface. Display and heading styles are used sparingly for the two main sides and winner reveal. Labels stay uppercase and dense, while balances, bets, countdowns, and payouts use tabular numerals so values do not jump as they update.

## Layout
The composition uses the existing 1600 × 900 landscape frame. The table stage occupies roughly the upper three quarters and the betting deck occupies the lower quarter; within that deck the compact roadmap takes the left column, main side bet the wider center, and eight card-count bets take the right column. The 1072 × 410 `royal-reveal-stage` is centered within the existing felt rather than placed above or in front of it. Its 790 × 132 Andar and Bahar lane plaques are stacked vertically, both card groups recenter on the table's exact horizontal center at x=800, and the 140 × 252 `joker-pedestal` stands to their right. At 1× reference scale, `dealt-card` is 68 × 96 and `joker-card` is 78 × 110; responsive layouts scale the complete stage uniformly instead of resizing individual cards. The seven recent counts and A/B percentages form one contained statistics footer below the roadmap. The visible chip rail is exactly ₹20, ₹50, ₹100, ₹200, ₹500, and ₹1,000. Canvas coordinates remain the source of truth and are scaled with one uniform transform so visuals and hit targets always agree.

## Elevation & Depth
Depth comes from a dark inset reveal well, a restrained hairline gold frame, subtle glass highlights, and controlled card shadows rather than heavy floating panels. Four low-opacity suit watermarks sit across the center field, while a compact dimensional card shoe uses layered card faces, a walnut-to-copper gradient, gold edges, and a controlled drop shadow to identify the deal origin. The joker itself keeps the same ivory face and ordinary dark keyline as every dealt card; its larger size and the concentric gold rings of `joker-pedestal` establish hierarchy. Selected chips and winning bets receive a focused gold or green halo. These details are quiet table furniture, never ornate decoration, and the existing felt remains visible around and between the lanes.

## Shapes
Betting tiles use small radii because casino layouts need exact edges and dense alignment. Chips and roadmap markers are circular; the joker and all dealt cards retain familiar portrait card proportions with small rounded corners. Medium rounding is reserved for grouped controls, the reveal-stage frame, and phase ribbons; fully rounded shapes should never be used for cards or the main Andar/Bahar split.

## Components
The neutral `phase-ribbon` states PLACE YOUR BETS with its countdown, LAST BETS, BETS LOCKED, or NO MORE BETS; DEALING remains in the separate round-status rail, and `result-banner-andar` or `result-banner-bahar` carries the winning-side summary. `royal-reveal-stage` anchors the stacked `andar-lane` and `bahar-lane`, the centered card groups, `joker-card`, and `joker-pedestal`; crimson and royal-blue labels plus small landing halos remain legible when cards overlap. `dealt-card` and `dealt-card-winning` share the 68 × 96 footprint, with a restrained external gold outline reserved for the winning card, while `joker-card` uses the 78 × 110 footprint and the ordinary card keyline. `side-bet-andar` and `side-bet-bahar` remain one split betting control with a 42px `side-bet-selected` wager chip; the eight `count-bet` tiles show range and payout, and `count-bet-winning` supplies the settled state. `chip` and `chip-selected` expose the six-value rail, both roadmap-dot variants update after settlement, and `account-bar` always displays balance, total bet, last win, live-mode status, and round number.

Each released card follows one purposeful flight from the dimensional shoe to the correct lane, with a short directional arc, slight rotation, and a duration capped at about 280ms. Standard-motion opacity follows the eased flight progress and reaches normal full opacity at landing, while lane recentering uses controlled easing instead of snapping. A lane-colored settle halo lasts about 180ms and supplies the only landing emphasis; there is no compression or bounce. With `prefers-reduced-motion: reduce`, release timing and order stay intact, each released card moves immediately to its final coordinates, and a roughly 160ms opacity-only fade replaces all translation, rotation, and scale. Cards never wander, loop, bounce repeatedly, or move their final hit regions.

## Do's and Don'ts
### Do
- Preserve the existing table proportions and scale the Canvas, visuals, and input map with one uniform transform.
- Keep both dealt-card groups centered at x=800, stack the Andar and Bahar lanes, and keep the joker on its dedicated right-side pedestal.
- Show odds and live phase continuously, with crimson Andar and royal-blue Bahar accents clear at a glance.
- Use restrained gold framing, faint suit watermarks, and the compact dimensional card shoe as quiet table furniture.
- Keep touch targets at least 44px after scaling where space allows.
- Use one capped deal flight, eased lane recentering, and a brief settle halo; in reduced motion, use final coordinates with opacity-only feedback.

### Don't
- Add dealer imagery, portraits, silhouettes, hands, or video.
- Change gameplay, game rules, odds, settlement, API contracts, or server behavior.
- Invent side bets the server cannot settle.
- Use flickering glows, soft unreadable text, compression, repeated card bounce, or moving hit regions.
- Independently resize the Canvas and its input map, or introduce reduced-motion translation, rotation, or scale.
