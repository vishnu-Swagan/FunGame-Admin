import { useEffect, useState } from "react";
import { Trophy } from "lucide-react";
import { api } from "@/lib/api";
import "./lastWinnerRotator.css";

const money = (value) => new Intl.NumberFormat("en-IN", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
}).format(Number(value || 0));

/**
 * A click-through, fixed live receipt. It intentionally consumes only settled
 * server payouts; it never fabricates a player or a winning amount.
 */
export function LastWinnerRotator({ slug }) {
  const [winners, setWinners] = useState([]);
  const [cursor, setCursor] = useState(0);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const { data } = await api.get(`/games/${slug}/recent-winners`);
        if (!alive) return;
        setWinners(Array.isArray(data.winners) ? data.winners : []);
      } catch (error) {
        /* A ticker is optional chrome; never interrupt play for a missed poll. */
      }
    };
    load();
    const poller = window.setInterval(load, 12000);
    return () => {
      alive = false;
      window.clearInterval(poller);
    };
  }, [slug]);

  useEffect(() => {
    setCursor(0);
    if (winners.length < 2) return undefined;
    const rotator = window.setInterval(() => {
      setCursor((value) => (value + 1) % winners.length);
    }, 3600);
    return () => window.clearInterval(rotator);
  }, [winners]);

  if (!winners.length) return null;
  const winner = winners[cursor % winners.length];

  return (
    <aside className="last-winner-rotator" aria-live="polite" aria-label="Recent live winner">
      <Trophy aria-hidden="true" />
      <span className="last-winner-label">LAST WIN</span>
      <span className="last-winner-slide" key={winner.id || `${winner.masked_id}-${cursor}`}>
        <b>{winner.masked_id}</b>
        <span>won</span>
        <strong>{money(winner.payout)} winnings</strong>
        {winner.round_number != null && <small>R{winner.round_number}</small>}
      </span>
    </aside>
  );
}
