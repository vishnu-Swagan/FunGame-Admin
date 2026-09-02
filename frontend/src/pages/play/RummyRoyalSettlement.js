import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronRight, Crown, ShieldCheck } from "lucide-react";

import { formatChips } from "@/components/common";
import { RUMMY_SETTLEMENT_AUDIO_CUES } from "./rummyAudio";
import "./rummy-royal-settlement.css";


export const RUMMY_ROYAL_SETTLEMENT_PHASES = Object.freeze({
  CELEBRATION: "celebration",
  SUMMARY: "summary",
});

const FOCUSABLE = "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";
const SUITS = Object.freeze({
  S: { symbol: "♠", name: "spades", red: false },
  H: { symbol: "♥", name: "hearts", red: true },
  D: { symbol: "♦", name: "diamonds", red: true },
  C: { symbol: "♣", name: "clubs", red: false },
});
const RANKS = Object.freeze({ 1: "A", 11: "J", 12: "Q", 13: "K" });
const SETTLEMENT_PARTICLES = Object.freeze(Array.from({ length: 18 }, (_, index) => ({
  id: index,
  left: `${4 + ((index * 29) % 92)}%`,
  drift: `${((index * 37) % 86) - 43}px`,
  rotation: `${(index * 47) % 300}deg`,
  delay: `${(index % 9) * 42}ms`,
  scale: String(.72 + ((index * 7) % 5) * .08),
})));
const SEAT_ANCHORS = Object.freeze([
  { left: "32.9%", top: "80.6%" },
  { left: "15.1%", top: "40%" },
  { left: "50%", top: "22.2%" },
  { left: "84.9%", top: "40%" },
  { left: "67%", top: "80.6%" },
]);

const isFiniteNumber = (value) => value !== "" && value != null && Number.isFinite(Number(value));
const readableLabel = (value, fallback) => String(value || fallback).replaceAll("_", " ");
const resultIdentity = (result) => [
  result?.settledAt,
  result?.winnerSeat,
  result?.winnerId,
  result?.reason,
].map((value) => String(value ?? "")).join(":");

const focusWithoutScroll = (element) => {
  if (!element || typeof element.focus !== "function") return;
  try { element.focus({ preventScroll: true }); } catch (_error) { element.focus(); }
};

const visibleName = (value, automated = false, fallback = "Player") => {
  const raw = String(value || "").trim();
  if (!automated) return raw || fallback;
  const cleaned = raw
    .replace(/\s*(?:[|:·—–-]\s*)?\b(?:bots?|auto)\b(?:\s*[|:·—–-]\s*[a-z0-9 ]+)?\s*$/i, "")
    .trim();
  return cleaned || fallback;
};

const cardRank = (card) => {
  if (card?.printedJoker || card?.code === "PJ") return "J";
  const numeric = Number(card?.rank);
  if (Number.isFinite(numeric) && numeric > 0) return RANKS[numeric] || String(numeric);
  const code = String(card?.code || "");
  return code.slice(0, Math.max(0, code.length - 1)) || "?";
};

const groupTone = (label, authoritative) => {
  if (!authoritative) return "neutral";
  const normalized = String(label || "").toUpperCase();
  if (normalized === "PURE_SEQUENCE" || normalized === "IMPURE_SEQUENCE") return "emerald";
  if (normalized === "SET") return "sapphire";
  if (normalized === "INVALID" || normalized === "UNGROUPED") return "ruby";
  return "neutral";
};

/**
 * Arrange only cards and labels included in the authoritative settlement row.
 * Missing grouping data falls back to a neutral "Final hand" rail and never
 * invents a valid sequence/set classification on the client.
 */
export function normalizeSettlementGroups(row) {
  const cards = Array.isArray(row?.cards) ? row.cards.filter(Boolean) : [];
  const indexed = new Map(cards.map((card) => [String(card.id), card]));
  const used = new Set();
  const groups = [];

  if (Array.isArray(row?.groups)) {
    row.groups.forEach((source, index) => {
      const cardIds = Array.isArray(source)
        ? source
        : Array.isArray(source?.cardIds)
          ? source.cardIds
          : [];
      const groupCards = cardIds
        .map((cardId) => indexed.get(String(cardId)))
        .filter((card) => card && !used.has(String(card.id)));
      groupCards.forEach((card) => used.add(String(card.id)));
      if (!groupCards.length) return;
      const authoritative = !Array.isArray(source) && Boolean(source?.label);
      groups.push({
        id: `settled-group-${index}`,
        label: authoritative ? readableLabel(source.label, `GROUP ${index + 1}`) : `GROUP ${index + 1}`,
        tone: groupTone(source?.label, authoritative),
        authoritative,
        cards: groupCards,
      });
    });
  }

  const ungrouped = cards.filter((card) => !used.has(String(card.id)));
  if (ungrouped.length) {
    const hadAuthoritativeGroups = groups.some((group) => group.authoritative);
    groups.push({
      id: "settled-group-remaining",
      label: hadAuthoritativeGroups ? "UNGROUPED" : "FINAL HAND",
      tone: hadAuthoritativeGroups ? "ruby" : "neutral",
      authoritative: hadAuthoritativeGroups,
      cards: ungrouped,
    });
  }
  return groups;
}

function SettlementCard({ card, compact = false }) {
  const joker = card?.printedJoker || card?.code === "PJ";
  const suit = SUITS[card?.suit];
  const rank = cardRank(card);
  const red = Boolean(suit?.red);
  return (
    <span
      className={`rrs-card ${red ? "is-red" : ""} ${joker ? "is-joker" : ""} ${compact ? "is-compact" : ""}`}
      role="img"
      aria-label={joker ? "Printed joker" : `${rank} of ${suit?.name || "unknown suit"}`}
      data-card-id={card?.id}
    >
      {joker ? (
        <><b>J</b><i aria-hidden="true">♛</i><small>JOKER</small></>
      ) : (
        <><b>{rank}</b><i aria-hidden="true">{suit?.symbol || "?"}</i><em aria-hidden="true">{suit?.symbol || "?"}</em></>
      )}
    </span>
  );
}

function AuthoritativeHand({ row, compact = false, ownerLabel = "Winner" }) {
  const groups = useMemo(() => normalizeSettlementGroups(row), [row]);
  if (!groups.length) {
    return <p className="rrs-cards-unavailable">Final cards were not supplied with this settlement.</p>;
  }
  return (
    <div className={`rrs-group-rail ${compact ? "is-compact" : ""}`} aria-label={`${ownerLabel} final hand`}>
      {groups.map((group, index) => (
        <section
          key={group.id}
          className={`rrs-card-group is-${group.tone}`}
          data-authoritative-label={group.authoritative ? "true" : "false"}
          style={{ "--rrs-group-index": index }}
          aria-label={`${group.label}, ${group.cards.length} cards`}
        >
          <div className="rrs-card-stack">
            {group.cards.map((card) => <SettlementCard key={card.id} card={card} compact={compact} />)}
          </div>
          <span className="rrs-group-band"><Check aria-hidden="true" />{group.label}</span>
        </section>
      ))}
    </div>
  );
}

function PayoutFigure({ value, displayValue, visualOnly = false }) {
  const available = isFiniteNumber(value);
  const exactLabel = available ? `${formatChips(value)} payout` : "Payout unavailable";
  return (
    <div className="rrs-payout" aria-label={visualOnly ? undefined : exactLabel} aria-hidden={visualOnly ? "true" : undefined} data-payout-chips={available ? String(value) : "unavailable"}>
      <span>PAYOUT</span>
      <strong>{available ? formatChips(displayValue) : "—"}</strong>
      <small>PAYOUT</small>
    </div>
  );
}

function Standings({ rows, winnerSeat }) {
  return (
    <section className="rrs-standings" aria-labelledby="rrs-standings-title">
      <header>
        <div><span>FINAL STANDINGS</span><h3 id="rrs-standings-title">Table scores</h3></div>
        <strong>{rows.length} SEATS SETTLED</strong>
      </header>
      <div className="rrs-standing-rows">
        {rows.map((row, index) => {
          const seatIndex = Number.isInteger(Number(row?.seatIndex)) ? Number(row.seatIndex) : index;
          const won = row?.status === "WON" || seatIndex === winnerSeat;
          const hasDelta = isFiniteNumber(row?.chipDelta);
          const delta = hasDelta ? Number(row.chipDelta) : null;
          return (
            <article key={`${seatIndex}:${row?.playerId || row?.displayName || index}`} className={won ? "is-winner" : ""} data-status={String(row?.status || "SETTLED").toLowerCase()}>
              <span className="rrs-standing-position" aria-label={won ? "Winner" : `Seat ${seatIndex + 1}`}>{won ? "♛" : seatIndex + 1}</span>
              <div className="rrs-standing-player">
                <b>{visibleName(row?.displayName, row?.isBot, `Seat ${seatIndex + 1}`)}</b>
                <small>SEAT {seatIndex + 1}</small>
              </div>
              <dl>
                <div><dt>STATUS</dt><dd>{readableLabel(row?.status, "SETTLED")}</dd></div>
                <div><dt>POINTS</dt><dd>{isFiniteNumber(row?.points) ? row.points : "—"}</dd></div>
              </dl>
              <strong className={delta > 0 ? "is-positive" : delta < 0 ? "is-negative" : ""}>
                {hasDelta ? `${delta > 0 ? "+" : ""}${formatChips(delta)}` : "—"} <small>BALANCE</small>
              </strong>
            </article>
          );
        })}
      </div>
    </section>
  );
}

/**
 * Drop-in replacement for the current Results component.
 *
 * Required compatibility props: result, viewerSeatIndex, onLobby,
 * reducedMotion. Optional orchestration props: phase, initialPhase,
 * onPhaseChange, onSkip, onCue, autoAdvance, celebrationDurationMs and
 * skipDelayMs. Audio cues are emitted only after this server result exists.
 */
export function RummyRoyalSettlement({
  result,
  viewerSeatIndex,
  onLobby,
  reducedMotion = false,
  phase: controlledPhase,
  initialPhase,
  onPhaseChange,
  onSkip,
  onCue,
  autoAdvance = true,
  celebrationDurationMs = 2800,
  skipDelayMs = 700,
}) {
  const defaultPhase = reducedMotion
    ? RUMMY_ROYAL_SETTLEMENT_PHASES.SUMMARY
    : initialPhase || RUMMY_ROYAL_SETTLEMENT_PHASES.CELEBRATION;
  const [internalPhase, setInternalPhase] = useState(defaultPhase);
  const [skipReady, setSkipReady] = useState(reducedMotion);
  const [displayPayout, setDisplayPayout] = useState(() => reducedMotion && isFiniteNumber(result?.payoutChips) ? Number(result.payoutChips) : 0);
  const dialogRef = useRef(null);
  const summaryButtonRef = useRef(null);
  const priorFocusRef = useRef(null);
  const callbackRef = useRef({ onLobby, onPhaseChange, onSkip, onCue });
  const playedCuesRef = useRef(new Set());
  const key = resultIdentity(result);
  const phase = controlledPhase || internalPhase;
  const rows = useMemo(() => Array.isArray(result?.rows) ? result.rows : [], [result?.rows]);
  const winnerSeat = Number.isInteger(Number(result?.winnerSeat)) ? Number(result.winnerSeat) : null;
  const winnerRow = rows.find((row) => Number(row?.seatIndex) === winnerSeat) || null;
  const viewerRow = rows.find((row) => Number(row?.seatIndex) === Number(viewerSeatIndex)) || null;
  const playerWon = winnerSeat != null && winnerSeat === Number(viewerSeatIndex);
  const winnerName = visibleName(result?.winnerName || winnerRow?.displayName, winnerRow?.isBot, "Winner");
  const reason = readableLabel(result?.reason, "ROUND SETTLED");
  const showcaseRow = winnerRow || viewerRow;
  const seatAnchor = winnerSeat != null && SEAT_ANCHORS[winnerSeat] ? SEAT_ANCHORS[winnerSeat] : { left: "50%", top: "45%" };

  useEffect(() => {
    callbackRef.current = { onLobby, onPhaseChange, onSkip, onCue };
  }, [onLobby, onPhaseChange, onSkip, onCue]);

  const emitCue = useCallback((cue, cueId = cue) => {
    const identity = `${key}:${cueId}`;
    if (playedCuesRef.current.has(identity)) return;
    playedCuesRef.current.add(identity);
    callbackRef.current.onCue?.(cue);
  }, [key]);

  const setPhase = useCallback((nextPhase) => {
    if (!controlledPhase) setInternalPhase(nextPhase);
    callbackRef.current.onPhaseChange?.(nextPhase);
  }, [controlledPhase]);

  const advanceToSummary = useCallback((skipped = false) => {
    if (phase !== RUMMY_ROYAL_SETTLEMENT_PHASES.CELEBRATION) return;
    if (skipped) callbackRef.current.onSkip?.();
    setPhase(RUMMY_ROYAL_SETTLEMENT_PHASES.SUMMARY);
  }, [phase, setPhase]);

  useEffect(() => {
    if (controlledPhase) return;
    const next = reducedMotion
      ? RUMMY_ROYAL_SETTLEMENT_PHASES.SUMMARY
      : initialPhase || RUMMY_ROYAL_SETTLEMENT_PHASES.CELEBRATION;
    setInternalPhase(next);
    setSkipReady(reducedMotion || next === RUMMY_ROYAL_SETTLEMENT_PHASES.SUMMARY);
    setDisplayPayout(reducedMotion && isFiniteNumber(result?.payoutChips) ? Number(result.payoutChips) : 0);
  }, [controlledPhase, initialPhase, key, reducedMotion, result?.payoutChips]);

  useEffect(() => {
    if (phase !== RUMMY_ROYAL_SETTLEMENT_PHASES.CELEBRATION) {
      setSkipReady(true);
      return undefined;
    }
    if (reducedMotion) {
      setSkipReady(true);
      return undefined;
    }
    setSkipReady(false);
    const timer = window.setTimeout(() => setSkipReady(true), Math.max(0, Number(skipDelayMs) || 700));
    return () => window.clearTimeout(timer);
  }, [key, phase, reducedMotion, skipDelayMs]);

  useEffect(() => {
    if (!autoAdvance || phase !== RUMMY_ROYAL_SETTLEMENT_PHASES.CELEBRATION) return undefined;
    const duration = reducedMotion
      ? 80
      : Math.max(Number(skipDelayMs) || 700, Number(celebrationDurationMs) || 2800);
    const timer = window.setTimeout(() => advanceToSummary(false), duration);
    return () => window.clearTimeout(timer);
  }, [advanceToSummary, autoAdvance, celebrationDurationMs, key, phase, reducedMotion, skipDelayMs]);

  useEffect(() => {
    if (phase === RUMMY_ROYAL_SETTLEMENT_PHASES.SUMMARY) {
      if (playerWon) emitCue(RUMMY_SETTLEMENT_AUDIO_CUES.FINAL_PAYOUT);
      return undefined;
    }
    if (reducedMotion) return undefined;

    const timers = [];
    const schedule = (delay, cue, cueId = cue) => {
      timers.push(window.setTimeout(() => emitCue(cue, cueId), delay));
    };
    schedule(180, RUMMY_SETTLEMENT_AUDIO_CUES.CARD_SETTLE);
    normalizeSettlementGroups(showcaseRow).forEach((_group, index) => {
      schedule(480 + (index * 115), RUMMY_SETTLEMENT_AUDIO_CUES.GROUP_VALIDATION, `group-validation-${index}`);
    });
    if (playerWon) {
      schedule(650, RUMMY_SETTLEMENT_AUDIO_CUES.ROYAL_RISE);
      if (Number(result?.payoutChips) > 0) {
        for (let index = 0; index < 10; index += 1) {
          schedule(850 + (index * 95), RUMMY_SETTLEMENT_AUDIO_CUES.COIN_TICK, `coin-tick-${index}`);
        }
      }
      schedule(1900, RUMMY_SETTLEMENT_AUDIO_CUES.FINAL_PAYOUT);
    }
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [emitCue, phase, playerWon, reducedMotion, result?.payoutChips, showcaseRow]);

  useEffect(() => {
    const exactPayout = isFiniteNumber(result?.payoutChips) ? Number(result.payoutChips) : null;
    if (exactPayout == null) {
      setDisplayPayout(0);
      return undefined;
    }
    if (reducedMotion || phase === RUMMY_ROYAL_SETTLEMENT_PHASES.SUMMARY || exactPayout === 0) {
      setDisplayPayout(exactPayout);
      return undefined;
    }
    let frame = null;
    let start = null;
    let delayTimer = null;
    const duration = 900;
    const tick = (timestamp) => {
      if (start == null) start = timestamp;
      const progress = Math.min(1, Math.max(0, (timestamp - start) / duration));
      const eased = 1 - ((1 - progress) ** 3);
      setDisplayPayout(progress === 1 ? exactPayout : Math.round(exactPayout * eased));
      if (progress < 1) frame = window.requestAnimationFrame(tick);
    };
    delayTimer = window.setTimeout(() => {
      frame = window.requestAnimationFrame(tick);
    }, 650);
    return () => {
      if (delayTimer != null) window.clearTimeout(delayTimer);
      if (frame != null) window.cancelAnimationFrame(frame);
    };
  }, [key, phase, reducedMotion, result?.payoutChips]);

  useEffect(() => {
    if (typeof document === "undefined") return undefined;
    priorFocusRef.current = document.activeElement;
    focusWithoutScroll(dialogRef.current);
    return () => {
      const prior = priorFocusRef.current;
      if (prior?.isConnected && prior !== document.body) focusWithoutScroll(prior);
    };
  }, []);

  useEffect(() => {
    if (phase === RUMMY_ROYAL_SETTLEMENT_PHASES.SUMMARY) focusWithoutScroll(summaryButtonRef.current || dialogRef.current);
  }, [phase]);

  useEffect(() => {
    if (typeof document === "undefined") return undefined;
    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        if (phase === RUMMY_ROYAL_SETTLEMENT_PHASES.CELEBRATION) {
          if (!skipReady) return;
          event.preventDefault();
          event.stopPropagation();
          advanceToSummary(true);
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        callbackRef.current.onLobby?.();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [...(dialogRef.current?.querySelectorAll(FOCUSABLE) || [])]
        .filter((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true");
      if (!focusable.length) {
        event.preventDefault();
        focusWithoutScroll(dialogRef.current);
        return;
      }
      const current = focusable.indexOf(document.activeElement);
      const backwards = event.shiftKey && current <= 0;
      const forwards = !event.shiftKey && (current < 0 || current === focusable.length - 1);
      if (!backwards && !forwards) return;
      event.preventDefault();
      focusWithoutScroll(event.shiftKey ? focusable[focusable.length - 1] : focusable[0]);
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [advanceToSummary, phase, skipReady]);

  if (!result || typeof result !== "object") return null;

  return (
    <section
      ref={dialogRef}
      tabIndex={-1}
      className={`rummy-royal-settlement ${playerWon ? "is-player-win" : "is-player-loss"}`}
      data-testid="rummy-royal-settlement"
      data-phase={phase}
      data-reduced-motion={reducedMotion ? "true" : "false"}
      role="dialog"
      aria-modal="true"
      aria-busy={phase === RUMMY_ROYAL_SETTLEMENT_PHASES.CELEBRATION ? "true" : "false"}
      aria-labelledby="rrs-title"
      aria-describedby="rrs-description"
    >
      <p className="rrs-sr-only" role="status" aria-live="polite">
        {phase === RUMMY_ROYAL_SETTLEMENT_PHASES.CELEBRATION
          ? `Round settled. ${playerWon ? "You win" : `${winnerName} wins`}.`
          : `Final standings ready. ${isFiniteNumber(result.payoutChips) ? `${formatChips(result.payoutChips)} payout.` : "Payout unavailable."}`}
      </p>

      {phase === RUMMY_ROYAL_SETTLEMENT_PHASES.CELEBRATION ? (
        <div className="rrs-celebration" data-testid="rrs-celebration-stage">
          <div className="rrs-celebration-veil" aria-hidden="true" />
          <div className="rrs-winner-halo" data-winner-seat={winnerSeat ?? "unknown"} style={{ left: seatAnchor.left, top: seatAnchor.top }} aria-hidden="true"><Crown /></div>
          {playerWon && !reducedMotion && (
            <div className="rrs-particles" aria-hidden="true" data-testid="rrs-particles">
              {SETTLEMENT_PARTICLES.map((particle) => (
                <i key={particle.id} style={{ left: particle.left, "--rrs-drift": particle.drift, "--rrs-rotation": particle.rotation, "--rrs-delay": particle.delay, "--rrs-particle-scale": particle.scale }} />
              ))}
            </div>
          )}
          <header className="rrs-win-lockup">
            <span>ROYAL HAND SETTLED</span>
            <div className="rrs-win-ribbon"><i aria-hidden="true">♛</i><b>CHAKRI WIN</b><i aria-hidden="true">♛</i></div>
            <h2 id="rrs-title">{playerWon ? "You win" : `${winnerName} wins`}</h2>
            <p id="rrs-description">{reason}</p>
          </header>
          <div className="rrs-showcase-hand">
            <AuthoritativeHand row={showcaseRow} ownerLabel={playerWon ? "Your" : `${winnerName}'s`} />
          </div>
          <footer className="rrs-celebration-footer">
            <PayoutFigure value={result.payoutChips} displayValue={displayPayout} />
            {skipReady && (
              <button type="button" className="rrs-skip" onClick={() => advanceToSummary(true)}>
                CONTINUE <ChevronRight />
              </button>
            )}
          </footer>
        </div>
      ) : (
        <div className="rrs-summary" data-testid="rrs-summary-stage">
          <header className="rrs-summary-hero">
            <div className="rrs-summary-seal" aria-hidden="true"><Crown /></div>
            <div className="rrs-summary-copy">
              <span>{playerWon ? "ROYAL HAND COMPLETE" : "ROUND COMPLETE"}</span>
              <h2 id="rrs-title">{playerWon ? "You win" : `${winnerName} wins`}</h2>
              <p id="rrs-description">{reason}</p>
            </div>
            <PayoutFigure value={result.payoutChips} displayValue={isFiniteNumber(result.payoutChips) ? Number(result.payoutChips) : 0} />
          </header>

          <div className="rrs-final-hand">
            <div className="rrs-final-hand-title"><Crown aria-hidden="true" /><span>WINNING HAND</span><b>{winnerName}</b></div>
            <AuthoritativeHand row={showcaseRow} compact ownerLabel={`${winnerName}'s`} />
          </div>

          <Standings rows={rows} winnerSeat={winnerSeat} />

          <footer className="rrs-summary-actions">
            <p><ShieldCheck /> Server-settled hand</p>
            <button ref={summaryButtonRef} type="button" onClick={() => callbackRef.current.onLobby?.()}>BACK TO LOBBY</button>
          </footer>
        </div>
      )}
    </section>
  );
}

export default RummyRoyalSettlement;
