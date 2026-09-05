# Wager mission concept preview

This standalone Remotion composition demonstrates the intended motion language for the wager-mission flow. It is a seven-second, 1080×1920, 30 fps concept using explicitly labeled mock data. It is not imported by the production React application.

The timeline shows:

1. A verified deposit receipt that states cash is not locked.
2. Server-authoritative mission progress moving from 0% to 100%.
3. A restrained gold-to-emerald completion state with a claim action.

All motion is derived from `useCurrentFrame()` and `interpolate()`. The composition uses `Sequence` with premounting and loads the generated vault asset through `staticFile()` from `frontend/public`. It contains no CSS transitions, CSS animations, or Tailwind animation classes.

Install and render the representative completion frame:

```sh
npm --prefix creative/remotion-wager install
npm --prefix creative/remotion-wager run render:still
```

Render the complete preview if needed:

```sh
npm --prefix creative/remotion-wager run render:preview
```

The production interface should reproduce only the approved timings with Framer Motion. Do not import Remotion or this composition into `frontend/src`.
