---
version: alpha
name: Chakri Live Andar Bahar
description: A cinematic live-table design system that mirrors the supplied Andar Bahar broadcast while remaining precise on every screen.
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
  pill: 999px
spacing:
  1: 2px
  2: 4px
  3: 8px
  4: 12px
  5: 16px
  6: 24px
components:
  phase-ribbon:
    backgroundColor: "{colors.navy-raised}"
    textColor: "{colors.ivory}"
    typography: "{typography.label}"
    rounded: "{rounded.xs}"
    padding: "{spacing.3}"
    height: 34px
  side-bet-andar:
    backgroundColor: "{colors.andar}"
    textColor: "{colors.ivory}"
    typography: "{typography.heading}"
    rounded: "{rounded.sm}"
    padding: "{spacing.4}"
    height: 102px
  side-bet-bahar:
    backgroundColor: "{colors.bahar}"
    textColor: "{colors.ivory}"
    typography: "{typography.heading}"
    rounded: "{rounded.sm}"
    padding: "{spacing.4}"
    height: 102px
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
    height: 45px
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
  roadmap-dot:
    backgroundColor: "{colors.andar}"
    textColor: "{colors.ivory}"
    typography: "{typography.caption}"
    rounded: "{rounded.pill}"
    size: 18px
  account-bar:
    backgroundColor: "{colors.navy}"
    textColor: "{colors.muted}"
    typography: "{typography.body}"
    rounded: "{rounded.xs}"
    padding: "{spacing.4}"
    height: 38px
---

# Chakri Live Andar Bahar Design System

## Overview
This system recreates the supplied live Andar Bahar broadcast for adult Chakri.Casino play-chip users on desktop, tablet, and mobile. The north star is cinematic, tactile, and unmistakably live: a human-scale dealer stage above a compact professional betting deck. It must never drift into a generic neon casino mockup or a cartoon card game.

## Colors
Midnight navy is the structural surface because it lets the warm dealer stage and table remain dominant. Crimson is reserved for Andar and royal blue for Bahar, matching the reference and making the two choices readable without extra ornament. Champagne and metallic gold connect the table, odds, selected chips, and focus states; ivory is the essential text color. All actionable text maintains AA-level contrast at its rendered size.

## Typography
Inter or the closest installed humanist-geometric sans is used throughout to match the compact broadcast interface. Display and heading styles are used sparingly for the two main sides and winner reveal. Labels stay uppercase and dense, while balances, bets, countdowns, and payouts use tabular numerals so values do not jump as they update.

## Layout
The composition uses the recording's 16:9 landscape frame. The live dealer/table stage occupies roughly the upper three quarters and the betting deck occupies the lower quarter; within that deck the compact roadmap takes the left column, main side bet the wider center, and card-count bets the right column. The seven recent counts and A/B percentages form one contained statistics footer below the roadmap. The visible chip rail is exactly ₹20, ₹50, ₹100, ₹200, ₹500, and ₹1,000. Canvas coordinates remain the source of truth and are scaled with one uniform transform so visuals and hit targets always agree.

## Elevation & Depth
Depth comes from dark inset wells, hairline gold rims, subtle glass highlights, and controlled shadows rather than large floating cards. Selected chips and winning bets receive a focused gold or green halo. The original photographed table remains visible at both edges; only the central dealing surface may use a narrow masking plate. The dealer remains behind the Canvas UI, while cards and chips are rendered on the game plane so interaction never feels detached from the table.

## Shapes
Betting tiles use small radii because casino layouts need exact edges and dense alignment. Chips, roadmap markers, and the joker well are circular. Medium rounding is reserved for grouped controls and phase ribbons; fully rounded shapes should never be used for the main Andar/Bahar split.

## Components
The phase ribbon always states BETTING OPEN, LAST BETS, NO MORE BETS, DEALING, or the winning side. `side-bet-andar` and `side-bet-bahar` form a single split control around the joker well, with a visible chip stack for every wager. Count-bet tiles show both range and payout, chips expose selected and pressed states, the roadmap updates after settlement, and the account bar always displays balance, total bet, last win, live-mode status, and round number.

## Do's and Don'ts
Do preserve the supplied camera and table proportions. Do show odds and live phase continuously. Do use natural irregular blinks, small head movement, and restrained one-hand/two-hand table gestures during betting. Do synchronize the dealer's right-hand pull from the shoe's front slot and the Canvas card release to one reveal clock. Do return to the clean front-facing smile when a winner is known, and reserve the hair-adjustment idle take for a 20-minute cadence. Do keep touch targets at least 44px after scaling where space allows. Do use motion to explain dealing and settlement. Don't play a spoken result announcement. Don't copy the recorded dealer's identity. Don't invent side bets the server cannot settle. Don't use flickering glows, soft unreadable text, or moving hit regions. Don't let responsive styling independently resize the Canvas and its input map.
