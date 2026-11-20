# Chicken Road action-flow fix

20 November 2026.

The live game no longer covers the road with “Confirming your action” during ordinary Play, GO or Cash Out requests. In-flight controls remain locked, the GO button provides a small pending indicator, and accessible busy state is exposed without interrupting the board. Genuine offline/unresolved-action recovery messages remain available.

Live hop duration is now 320 ms, down from 480 ms. Camera, chicken movement, leg and shadow timing share the same duration. Outcomes and cash-out amounts still come from the server; this does not change odds, financial validation or network latency.

116 focused tests passed across the live game, durable action client and practice game. Coverage includes delayed responses without a blocking overlay, repeated taps producing one request, synchronized animation completion, cash-out state, uncertain-action recovery and original-operation retries. The production build passed and its static assets were deployed. No backend or payment settings changed.
