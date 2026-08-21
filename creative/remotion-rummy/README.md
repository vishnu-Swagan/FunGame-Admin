# Rummy win atmosphere

This Remotion composition is the motion source for the live Rummy result burst. It uses a 30 fps, 120-frame timeline, deterministic confetti positions, a critically damped card entrance, and the same generated card-back texture used by the browser game.

Render the approved atmosphere still from the repository root:

```sh
npx --package=remotion@4.0.515 --package=@remotion/cli@4.0.515 remotion still creative/remotion-rummy/index.jsx RummyWinAtmosphere rummy-win-atmosphere.png --frame=48 --public-dir=frontend/public
```

The live React surface reproduces these frame timings with Framer Motion so the effect remains interactive and does not download a video during play. Reduced-motion users receive the result without the burst.
