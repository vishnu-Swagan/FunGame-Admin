# Premium games accessibility report

## Rummy implemented checks

- Cards are real buttons for selection with rank/suit accessible names and pressed state.
- Draw piles, actions, mute, leave, lobby, and dialog controls have explicit names or visible labels.
- Turn instructions use a polite live region; reconnect and timer states expose text.
- One timer is rendered only inside the active player's avatar ring.
- Group validity, status, and results include text and do not rely on colour alone.
- Keyboard focus has a high-contrast visible outline; tap targets are sized for touch layouts.
- Drop and result overlays use dialog semantics; reduced-motion preferences preserve final state while suppressing decorative motion.
- Safe viewport variables, device insets, portrait/landscape layouts, bounded overflow, and thumb-reachable action rows are implemented.

Pending before accessibility sign-off: automated axe/contrast scan, VoiceOver/TalkBack traversal, switch/keyboard reordering validation, 200% zoom, and physical-device notch/gesture-region evidence.
