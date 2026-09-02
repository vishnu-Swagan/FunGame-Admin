import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Clock3, Coins, Crown, ShieldCheck } from "lucide-react";

import { BrandWordmark } from "@/components/Brand";
import { formatChips } from "@/components/common";
import "./rummy-premium-lobby.css";


const TABLE_CYCLE_SECONDS = 180;
const LEVEL_TONES = Object.freeze({
  LV1: { from: "#128566", to: "#063f35", metal: "#d6b75e" },
  LV2: { from: "#278b58", to: "#0c4930", metal: "#e5c66c" },
  LV3: { from: "#138a83", to: "#073f43", metal: "#efca6c" },
  LV4: { from: "#385aab", to: "#131f53", metal: "#eac15d" },
  LV5: { from: "#a02a3d", to: "#4b0b23", metal: "#f5cd6c" },
});
const FAN_CARDS = Object.freeze([
  ["A", "♠", false], ["K", "♥", true], ["Q", "♣", false], ["J", "♦", true],
  ["10", "♠", false], ["9", "♥", true], ["8", "♣", false], ["7", "♦", true],
  ["6", "♠", false], ["5", "♥", true], ["4", "♣", false], ["3", "♦", true],
  ["2", "♠", false],
]);

const firstFinite = (...values) => values.find((value) => Number.isFinite(Number(value)));

const parseScheduleTimestamp = (value) => {
  if (value == null || value === "") return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    const milliseconds = numeric < 1e12 ? numeric * 1000 : numeric;
    return milliseconds > 0 ? milliseconds : null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

function scheduleBasis(source) {
  if (!source) return null;
  const timing = source.matchmaking || source.liveMatchmaking || source;
  const scheduledAt = parseScheduleTimestamp(
    timing.scheduledStartAtEpoch
      ?? timing.scheduledStartAt
      ?? timing.nextScheduledStartAtEpoch
      ?? timing.nextScheduledStartAt
      ?? timing.nextTableStartsAt
      ?? timing.nextGameStartsAt
      ?? timing.scheduledStartTime
      ?? timing.matchStartsAt
      ?? timing.nextRoundAt,
  );
  const directSeconds = firstFinite(
    timing.startsIn,
    timing.nextTableStartsIn,
    timing.nextGameStartsIn,
    timing.scheduledStartsIn,
    timing.scheduledStartIn,
    timing.matchStartsIn,
  );
  if (scheduledAt == null && directSeconds == null) return null;
  return {
    scheduledAt,
    directSeconds: directSeconds == null ? null : Math.max(0, Number(directSeconds)),
    observedAt: Date.now(),
    cycleSeconds: Math.max(1, Number(timing.cycleSeconds || timing.tableCycleSeconds || TABLE_CYCLE_SECONDS)),
  };
}

function usePremiumSchedule(source) {
  const sourceKey = JSON.stringify({
    id: source?.id,
    matchmaking: source?.matchmaking,
    liveMatchmaking: source?.liveMatchmaking,
    scheduledStartAtEpoch: source?.scheduledStartAtEpoch,
    scheduledStartAt: source?.scheduledStartAt,
    nextScheduledStartAtEpoch: source?.nextScheduledStartAtEpoch,
    nextScheduledStartAt: source?.nextScheduledStartAt,
    nextTableStartsAt: source?.nextTableStartsAt,
    nextGameStartsAt: source?.nextGameStartsAt,
    scheduledStartTime: source?.scheduledStartTime,
    matchStartsAt: source?.matchStartsAt,
    nextRoundAt: source?.nextRoundAt,
    startsIn: source?.startsIn,
    nextTableStartsIn: source?.nextTableStartsIn,
    nextGameStartsIn: source?.nextGameStartsIn,
    scheduledStartsIn: source?.scheduledStartsIn,
    scheduledStartIn: source?.scheduledStartIn,
    matchStartsIn: source?.matchStartsIn,
    cycleSeconds: source?.cycleSeconds,
    tableCycleSeconds: source?.tableCycleSeconds,
  });
  const basis = useMemo(() => scheduleBasis(source), [sourceKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    setNow(Date.now());
    if (!basis) return undefined;
    const timer = globalThis.setInterval(() => setNow(Date.now()), 1000);
    return () => globalThis.clearInterval(timer);
  }, [basis]);

  if (!basis) return null;
  const seconds = basis.scheduledAt == null
    ? Math.max(0, Math.ceil(basis.directSeconds - ((now - basis.observedAt) / 1000)))
    : Math.max(0, Math.ceil((basis.scheduledAt - now) / 1000));
  return { ...basis, seconds };
}

const formatCountdown = (seconds) => {
  const safe = Math.max(0, Math.ceil(Number(seconds) || 0));
  return `${String(Math.floor(safe / 60)).padStart(2, "0")}:${String(safe % 60).padStart(2, "0")}`;
};

function PremiumSchedule({ category }) {
  const schedule = usePremiumSchedule(category);
  if (!schedule) return null;
  const startLabel = schedule.scheduledAt == null
    ? "Scheduled by server"
    : new Date(schedule.scheduledAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return (
    <div className="rpl-schedule" data-testid="rummy-next-table-countdown" role="timer" aria-live="off">
      <Clock3 aria-hidden="true" />
      <span><small>NEXT TABLE</small><b>{startLabel}</b></span>
      <strong>{formatCountdown(schedule.seconds)}</strong>
    </div>
  );
}

function DecorativeCardFan() {
  const middle = (FAN_CARDS.length - 1) / 2;
  return (
    <div className="rpl-card-fan" aria-hidden="true">
      {FAN_CARDS.map(([rank, suit, red], index) => (
        <i
          // The fan is decorative and deterministic; rank+suit is unique here.
          key={`${rank}-${suit}`}
          className={red ? "is-red" : ""}
          style={{ "--fan-offset": index - middle, "--fan-depth": Math.abs(index - middle) }}
        >
          <b>{rank}</b><span>{suit}</span>
        </i>
      ))}
    </div>
  );
}

function categoryTone(category) {
  return {
    ...LEVEL_TONES[category?.id] || LEVEL_TONES.LV1,
    ...category?.accent,
  };
}

const requiredLiveChips = (category) => Math.max(
  Number(category?.minChipBalance ?? 0),
  Number(category?.entryChips ?? 0),
);

function selectFeaturedCategory(categories, balance) {
  const configured = categories.find((category) => category.featured || category.recommended || category.isFeatured);
  if (configured) return { id: configured.id, badge: "FEATURED" };
  if (balance !== null && balance !== "" && Number.isFinite(Number(balance))) {
    const affordable = categories
      .filter((category) => Number(balance) >= requiredLiveChips(category))
      .sort((left, right) => requiredLiveChips(left) - requiredLiveChips(right));
    if (affordable.length) return { id: affordable[affordable.length - 1].id, badge: "BEST MATCH" };
  }
  return { id: categories[0]?.id, badge: "START HERE" };
}

function LevelCard({ category, balance, busy, joinFailure, preview, featured, featuredBadge, onJoin }) {
  const balanceKnown = balance !== null && balance !== "" && Number.isFinite(Number(balance));
  const liveRequiredChips = requiredLiveChips(category);
  const enough = balanceKnown && Number(balance) >= liveRequiredChips;
  const failedJoin = joinFailure?.categoryId === category.id ? joinFailure : null;
  const tone = categoryTone(category);
  const labelId = `rpl-level-${String(category.id).toLowerCase()}`;
  const statusId = `rpl-status-${String(category.id).toLowerCase()}`;
  const liveLabel = preview
    ? "LIVE DISABLED"
    : failedJoin?.mode === "LIVE" ? "RETRY LIVE" : "JOIN LIVE";
  const practiceLabel = failedJoin?.mode === "PRACTICE" ? "RETRY PRACTICE" : "PRACTICE TABLE";

  return (
    <article
      className={`rpl-level-card ${featured ? "is-featured" : "is-compact"}`}
      data-category-id={category.id}
      style={{ "--level-from": tone.from, "--level-to": tone.to, "--level-metal": tone.metal }}
      aria-labelledby={labelId}
    >
      <header>
        <div className="rpl-level-name">
          <span>{category.id}</span>
          <div><h2 id={labelId}>{category.displayName}</h2><small>ROYAL RUMMY TABLE</small></div>
        </div>
        {featured && <b className="rpl-best-match"><Crown aria-hidden="true" />{featuredBadge}</b>}
      </header>

      <div className="rpl-level-content">
        <div className="rpl-entry-medallion" aria-hidden="true"><i /><span><small>ENTRY</small><b>{formatChips(category.entryChips)}</b></span></div>
        <dl>
          <div><dt>ENTRY STAKE</dt><dd>{formatChips(category.entryChips)}</dd></div>
          <div><dt>POINT VALUE</dt><dd>{formatChips(category.pointsValue)}</dd></div>
          <div><dt>TURN</dt><dd>{category.turnDurationSeconds}<small>s</small></dd></div>
        </dl>
      </div>

      <PremiumSchedule category={category} />

      <div className="rpl-level-actions">
        <button
          type="button"
          className="is-live"
          disabled={busy || preview || !enough}
          aria-describedby={statusId}
          onClick={() => onJoin(category.id, "LIVE")}
        >
          {liveLabel}
        </button>
        <button
          type="button"
          className="is-practice"
          disabled={busy}
          aria-describedby={failedJoin?.mode === "PRACTICE" ? statusId : undefined}
          onClick={() => onJoin(category.id, "PRACTICE")}
        >
          {practiceLabel}
        </button>
      </div>

      <small id={statusId} className={`rpl-level-status ${failedJoin ? "is-error" : ""}`} role={failedJoin ? "alert" : undefined}>
        {failedJoin?.message
          || (preview
            ? "Preview mode · Practice remains available"
            : !balanceKnown
              ? "Balance unavailable · Practice remains available"
              : !enough
                ? `Live requires a ${formatChips(liveRequiredChips)} balance · Practice remains available`
                : "Live entry available")}
      </small>
    </article>
  );
}

/**
 * Drop-in replacement for the current Rummy CategoryLobby.
 * Keep this prop contract stable so integration is limited to an import swap.
 */
export function CategoryLobby({
  categories = [],
  balance,
  busy = false,
  loading = false,
  error,
  joinFailure,
  preview = false,
  onJoin,
  onRetry,
  onExit,
}) {
  const featuredCategory = selectFeaturedCategory(categories, balance);

  return (
    <main className="rummy-premium-lobby" data-testid="rummy-category-lobby">
      <header className="rpl-header">
        <button type="button" className="rpl-back" onClick={onExit} aria-label="Back to Rummy details"><ArrowLeft /></button>
        <BrandWordmark className="rpl-brand" logoClassName="rpl-brand-lockup" />
        <div className="rpl-balance" aria-label={`${balance == null ? "Balance unavailable" : `${formatChips(balance)} balance`}`}>
          <Coins aria-hidden="true" /><span><small>BALANCE</small><b>{balance == null ? "—" : formatChips(balance)}</b></span><em>FUNDS</em>
        </div>
      </header>

      <section className="rpl-intro" aria-labelledby="rpl-lobby-title">
        <div className="rpl-intro-copy">
          <span>LIVE MODE · FIVE-SEAT INDIAN RUMMY</span>
          <h1 id="rpl-lobby-title">Choose your royal table</h1>
          <p>Thirteen cards. Two sequences. One pure sequence. Pick the table that matches your balance.</p>
        </div>
        <DecorativeCardFan />
      </section>

      {loading && (
        <section className="rpl-state" role="status" aria-live="polite">
          <span className="rpl-state-crest" aria-hidden="true">♛</span>
          <b>Preparing the royal tables…</b>
          <i aria-hidden="true" />
        </section>
      )}

      {!loading && error && categories.length === 0 && (
        <section className="rpl-state is-error" role="alert">
          <span className="rpl-state-crest" aria-hidden="true">♜</span>
          <b>Rummy tables are temporarily unavailable.</b>
          <button type="button" onClick={onRetry}>TRY AGAIN</button>
        </section>
      )}

      {!loading && !error && categories.length === 0 && (
        <section className="rpl-state" role="status">
          <span className="rpl-state-crest" aria-hidden="true">♛</span>
          <b>No Rummy tables are listed right now.</b>
          <button type="button" onClick={onRetry}>REFRESH TABLES</button>
        </section>
      )}

      {!loading && categories.length > 0 && (
        <section className="rpl-mosaic" aria-label="Rummy table categories">
          {categories.map((category) => (
            <LevelCard
              key={category.id}
              category={category}
              balance={balance}
              busy={busy}
              joinFailure={joinFailure}
              preview={preview}
              featured={category.id === featuredCategory.id}
              featuredBadge={featuredCategory.badge}
              onJoin={onJoin}
            />
          ))}
        </section>
      )}

      <footer className="rpl-footer">
        <span>CHAKRI.CASINO · RUMMY</span>
      </footer>
    </main>
  );
}

export default CategoryLobby;
