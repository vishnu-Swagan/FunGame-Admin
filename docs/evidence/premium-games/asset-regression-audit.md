# Asset regression audit

## Rummy boundary

- Approved reference manifest: `rummy-reference-2026-08-21-v1`.
- All 11 captured references remain under `docs/references/`; none is imported by runtime code.
- Runtime card faces and backs are CSS/DOM originals; the lobby tile uses only `/game-art/rummy.png`.
- No rupee/dollar symbol, third-party logo, captured face, store header, browser chrome, watermark, or device overlay from the references is shipped by the Rummy implementation.
- Missing catalogue art continues through the existing controlled `GameArt` pattern fallback; it does not load an earlier Rummy screenshot.

The master programme's cross-game blocked-path/hash/cache inventory is not represented by this Rummy-only entry and remains a separate release gate.
