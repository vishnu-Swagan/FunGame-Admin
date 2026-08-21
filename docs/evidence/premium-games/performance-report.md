# Premium games performance report

## Rummy measurements — 2026-08-21

- Original Rummy catalogue artwork: approximately 2.4 MiB PNG, lazy-loaded by the existing catalogue artwork component.
- Forty random 14-card `best_arrangement` evaluations on Python 3.11.15: median about 55 ms, observed p95 about 58 ms, maximum about 59 ms on the development Mac.
- UI motion uses transform/opacity and bounded effects. Reduced-motion mode disables decorative pulsing, seat glow, spin, and transitions.
- State polling is recursive, single-flight, abortable during actions, cleared on teardown, and uses bounded failure backoff. Stale lower-version responses are rejected before rendering.
- CPU-heavy bot arrangement/discard calculations are moved off the async event loop.
- The exact staged release tree built at 706.85 kB JavaScript and 52.42 kB CSS gzip. CRA's large-bundle advisory remains; route-level code splitting is recommended before a strict initial-load budget is signed off.

The artwork should be converted to a measured modern delivery format before a strict low-bandwidth budget is signed off. Bundle-size results are recorded after the final production build; long-session memory and lower-end-device frame pacing remain release evidence gates.
