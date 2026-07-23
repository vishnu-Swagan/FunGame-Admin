import { useState, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { toast } from "sonner";
import { Plus, Minus, RotateCcw, ChevronRight } from "lucide-react";
import { api, errMsg } from "@/lib/api";
import { sfx } from "@/lib/sound";
import { PlayShell } from "@/components/play/PlayShell";
import { CoinShower } from "@/pages/play/slots/slotFx";
import { formatChips } from "@/components/common";

const CHIPS = [
  { v: 10, bg: "#e2e8f0", fg: "#0f172a" }, { v: 50, bg: "#22d3ee", fg: "#083344" },
  { v: 100, bg: "#ffc740", fg: "#3a2a00" }, { v: 500, bg: "#f472b6", fg: "#500724" },
  { v: 1000, bg: "#4ade80", fg: "#052e16" },
];
const SUIT = { S: { ch: "♠", red: false }, H: { ch: "♥", red: true }, D: { ch: "♦", red: true }, C: { ch: "♣", red: false } };

/* ---- a single dealt card: flips in (scaleX) with a drop, like a real deal ---- */
function Card({ code, i = 0, big }) {
  const back = code === "??";
  const rank = back ? "" : code.slice(0, -1);
  const suit = back ? null : SUIT[code.slice(-1)];
  const w = big ? 46 : 42, h = big ? 64 : 58;
  return (
    <motion.div
      initial={{ scaleX: 0, y: -26, opacity: 0 }}
      animate={{ scaleX: 1, y: 0, opacity: 1 }}
      transition={{ type: "spring", stiffness: 300, damping: 24, delay: i * 0.09 }}
      className="relative rounded-[5px] flex flex-col justify-between shrink-0"
      style={{
        width: w, height: h, marginLeft: i === 0 ? 0 : -Math.round(w * 0.42),
        background: back
          ? "repeating-linear-gradient(45deg,#7f1d1d,#7f1d1d 4px,#a01823 4px,#a01823 8px)"
          : "linear-gradient(160deg,#ffffff 0%,#f2f4f9 70%,#e7eaf2 100%)",
        border: back ? "1.5px solid #ffd447" : "1px solid #c6cad6",
        boxShadow: "0 4px 10px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.7)",
        padding: 3, transformOrigin: "left center",
      }}
    >
      {!back ? (
        <>
          <span className="font-black leading-none" style={{ fontSize: big ? 14 : 12, color: suit.red ? "#d4152a" : "#12131a" }}>{rank}</span>
          <span className="self-center leading-none" style={{ fontSize: big ? 22 : 19, color: suit.red ? "#d4152a" : "#12131a" }}>{suit.ch}</span>
          <span className="self-end font-black leading-none rotate-180" style={{ fontSize: big ? 14 : 12, color: suit.red ? "#d4152a" : "#12131a" }}>{rank}</span>
        </>
      ) : (
        <span className="absolute inset-0 grid place-items-center text-primary/80" style={{ fontSize: 18 }}>♦</span>
      )}
    </motion.div>
  );
}

/* ---- real shuffle: two halves riffle together, then a cut ---- */
function ShuffleOverlay() {
  return (
    <motion.div
      className="absolute inset-0 z-30 flex flex-col items-center justify-center"
      style={{ background: "rgba(4,22,13,0.74)", backdropFilter: "blur(2px)" }}
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
    >
      <div className="relative" style={{ width: 130, height: 74 }}>
        {Array.from({ length: 14 }).map((_, k) => {
          const rightHalf = k % 2 === 0;
          return (
            <motion.div
              key={k}
              className="absolute rounded-[3px]"
              style={{
                width: 36, height: 52, left: 65 - 18, top: 11,
                background: "linear-gradient(180deg,#c01523,#7f1d1d)",
                border: "1px solid #ffd447",
                boxShadow: "0 2px 7px rgba(0,0,0,0.55)",
                zIndex: k,
              }}
              initial={{ x: rightHalf ? 40 : -40, rotate: rightHalf ? 14 : -14 }}
              animate={{
                x: [rightHalf ? 40 : -40, 0, rightHalf ? 5 : -5, 0],
                rotate: [rightHalf ? 14 : -14, 0, 0, 0],
                y: [0, 0, -2, 0],
              }}
              transition={{ duration: 1.05, delay: k * 0.045, repeat: Infinity, repeatDelay: 0.25, ease: "easeInOut" }}
            />
          );
        })}
      </div>
      <p className="mt-5 text-xs font-black tracking-[0.34em] text-primary">SHUFFLING</p>
      <p className="text-[9px] text-white/55 mt-1 tracking-wide">6-deck shoe · freshly shuffled</p>
    </motion.div>
  );
}

const Spot = ({ label, sub, total, onAdd, disabled, small }) => (
  <button
    onClick={onAdd}
    disabled={disabled}
    className={`relative rounded-full border-2 border-dashed flex flex-col items-center justify-center transition-[transform,border-color] duration-100 ${disabled ? "opacity-60" : "active:scale-95 hover:border-primary/70"} ${small ? "h-11 w-11" : "h-16 w-16"}`}
    style={{ borderColor: total > 0 ? "#ffd447" : "rgba(255,255,255,0.3)", background: total > 0 ? "rgba(255,212,71,0.12)" : "rgba(0,0,0,0.2)" }}
  >
    {total > 0 ? (
      <span className="font-extrabold tabular-nums text-primary" style={{ fontSize: small ? 11 : 14 }}>{formatChips(total)}</span>
    ) : (
      <>
        <span className={`font-gaming font-bold text-white/70 ${small ? "text-[8px]" : "text-[10px]"}`}>{label}</span>
        {sub && !small && <span className="text-[8px] text-white/40">{sub}</span>}
      </>
    )}
  </button>
);

export default function BlackjackGame({ game }) {
  const [state, setState] = useState(null);
  const [bets, setBets] = useState([{ bet: 0, pp: 0, t3: 0 }]);
  const [lastBets, setLastBets] = useState(null);
  const [chip, setChip] = useState(100);
  const [busy, setBusy] = useState(false);
  const [shuffling, setShuffling] = useState(false);

  const refresh = useCallback(async () => {
    try { const { data } = await api.get("/blackjack/state"); setState(data); } catch { /* */ }
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  const status = state?.status;
  const playing = status === "player_turn";
  const insurance = status === "insurance";
  const done = status === "done";
  const betting = !state || status === "idle";   // done is its OWN phase now
  const balance = state?.balance;

  const addTo = (idx, key) => setBets((b) => b.map((h, i) => (i === idx ? { ...h, [key]: h[key] + chip } : h)));
  const addHand = () => bets.length < 5 && setBets((b) => [...b, { bet: 0, pp: 0, t3: 0 }]);
  const removeHand = () => bets.length > 1 && setBets((b) => b.slice(0, -1));
  const clearBets = () => setBets((b) => b.map(() => ({ bet: 0, pp: 0, t3: 0 })));
  const totalStake = bets.reduce((a, h) => a + h.bet + h.pp + h.t3, 0);

  const deal = async () => {
    const hands = bets.filter((h) => h.bet > 0).map((h) => ({ bet: h.bet, pp: h.pp, t3: h.t3 }));
    if (!hands.length) { toast.info("Place a bet on at least one hand"); return; }
    setBusy(true);
    setLastBets(bets.map((h) => ({ ...h })));   // remember for quick rebet
    setShuffling(true);
    (sfx.shuffle ? sfx.shuffle() : sfx.chip && sfx.chip());
    const minShow = new Promise((r) => setTimeout(r, 1550));   // let the shuffle read
    try {
      const [{ data }] = await Promise.all([api.post("/blackjack/deal", { hands }), minShow]);
      setShuffling(false);
      setState(data);
      sfx.flick && sfx.flick();
    } catch (e) {
      setShuffling(false);
      toast.error(errMsg(e));
    } finally { setBusy(false); }
  };
  const act = async (action) => {
    setBusy(true); sfx.flick && sfx.flick();
    try { const { data } = await api.post("/blackjack/action", { action }); setState(data); }
    catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };
  const insure = async (take) => {
    setBusy(true);
    try { const { data } = await api.post("/blackjack/insurance", { take }); setState(data); }
    catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };
  // THE fix: after a round, return to a clean betting table with the last
  // bets pre-filled so the next hand is one tap away (or adjust freely).
  const nextHand = () => {
    setState({ status: "idle", balance: state?.balance });
    setBets(lastBets && lastBets.some((h) => h.bet > 0) ? lastBets.map((h) => ({ ...h })) : [{ bet: 0, pp: 0, t3: 0 }]);
  };

  useEffect(() => {
    if (done && state?.net > 0) { sfx.winCelebration ? sfx.winCelebration() : sfx.slotBell && sfx.slotBell(); }
    else if (done && state?.net < 0) { sfx.lose && sfx.lose(); }
  }, [done, state?.net]);

  const activeIdx = state?.active;
  const activeHand = playing ? state.hands[activeIdx] : null;
  const showTable = status && status !== "idle";

  const OUTCOME_TONE = { BLACKJACK: "#ffd447", WIN: "#4ade80", PUSH: "#a9bce0", LOSE: "#fb7185", BUST: "#fb7185" };

  return (
    <PlayShell game={game} balance={balance}>
      {/* ---- 3D felt table ---- */}
      <div style={{ perspective: "1100px" }}>
        <div
          className="relative rounded-2xl border-2 overflow-hidden p-3"
          style={{
            borderColor: "#c9a22766",
            background: "radial-gradient(130% 115% at 50% 2%, #1f9455 0%, #157340 46%, #093f23 100%)",
            boxShadow: "0 20px 44px rgba(0,0,0,0.55), inset 0 0 80px rgba(0,0,0,0.45)",
            transform: "rotateX(6deg)", transformStyle: "preserve-3d",
          }}
          data-testid="blackjack-table"
        >
          <div aria-hidden className="absolute inset-1.5 rounded-xl pointer-events-none" style={{ border: "1px solid rgba(201,162,39,0.4)" }} />
          <div aria-hidden className="absolute inset-0 fg-noise pointer-events-none" style={{ opacity: 0.05 }} />

          {/* the shoe, top-right */}
          <div aria-hidden className="absolute top-2.5 right-2.5 flex" style={{ transform: "rotate(-4deg)" }}>
            {[0, 1, 2].map((k) => (
              <span key={k} className="rounded-[3px] block" style={{
                width: 22, height: 30, marginLeft: k ? -17 : 0,
                background: "linear-gradient(180deg,#c01523,#7f1d1d)", border: "1px solid #ffd44788",
                boxShadow: "0 2px 5px rgba(0,0,0,0.5)",
              }} />
            ))}
          </div>

          <AnimatePresence>{shuffling && <ShuffleOverlay />}</AnimatePresence>
          {done && state?.net > 0 && <CoinShower />}

          <p className="text-center text-[9px] font-extrabold tracking-[0.22em] text-white/70 mb-1">BLACKJACK PAYS 3 TO 2 · DEALER STANDS ON ALL 17</p>

          {/* dealer */}
          <div className="flex flex-col items-center gap-1 min-h-[76px]">
            <span className="text-[9px] font-bold tracking-widest text-white/55">
              DEALER {state?.dealer && showTable ? `· ${state.dealer.value}${!done ? "+" : ""}` : ""}
            </span>
            <div className="flex">
              {(state?.dealer?.cards || []).map((c, i) => <Card key={`${i}-${c}`} code={c} i={i} big />)}
            </div>
          </div>

          {/* player hands / betting spots */}
          {showTable ? (
            <div className="mt-3 flex justify-center gap-2 flex-wrap">
              {state.hands.map((h, i) => (
                <div key={i} className={`flex flex-col items-center gap-1 rounded-xl px-2 py-1.5 transition-colors ${playing && i === activeIdx ? "bg-primary/12 ring-1 ring-primary/60" : ""}`}>
                  <div className="flex">{h.cards.map((c, j) => <Card key={`${j}-${c}`} code={c} i={j} big />)}</div>
                  <span className="text-[11px] font-bold text-white tabular-nums">{h.value}{h.soft ? " ·soft" : ""}{h.bust ? " BUST" : ""}</span>
                  <div className="flex items-center gap-1">
                    <span className="text-[9px] text-white/55 tabular-nums">{formatChips(h.bet)}</span>
                    {h.outcome && <span className="text-[9px] font-extrabold" style={{ color: OUTCOME_TONE[h.outcome] || "#fff" }}>{h.outcome}{h.payout > 0 ? ` +${formatChips(h.payout)}` : ""}</span>}
                  </div>
                  {(h.pp_mult > 0 || h.t3_mult > 0) && (
                    <span className="text-[8px] font-bold text-[#ffd447]">{h.pp_label ? `PP ${h.pp_mult}:1` : ""}{h.t3_label ? ` ${h.t3_label} ${h.t3_mult}:1` : ""}</span>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className="mt-3">
              <div className="flex justify-center gap-2 flex-wrap">
                {bets.map((h, i) => (
                  <div key={i} className="flex flex-col items-center gap-1">
                    <Spot label={`HAND ${i + 1}`} total={h.bet} onAdd={() => addTo(i, "bet")} />
                    {i === 0 && (
                      <div className="flex gap-1 mt-0.5">
                        <Spot label="PP" sub="pairs" total={h.pp} onAdd={() => addTo(0, "pp")} small />
                        <Spot label="21+3" total={h.t3} onAdd={() => addTo(0, "t3")} small />
                      </div>
                    )}
                  </div>
                ))}
              </div>
              <div className="flex items-center justify-center gap-2 mt-2">
                <button onClick={removeHand} disabled={bets.length <= 1} className="h-7 w-7 rounded-full border border-white/20 bg-white/5 grid place-items-center disabled:opacity-40"><Minus className="h-3.5 w-3.5 text-white/80" /></button>
                <span className="text-[10px] text-white/60 tabular-nums">{bets.length} hand{bets.length > 1 ? "s" : ""}</span>
                <button onClick={addHand} disabled={bets.length >= 5} className="h-7 w-7 rounded-full border border-white/20 bg-white/5 grid place-items-center disabled:opacity-40"><Plus className="h-3.5 w-3.5 text-white/80" /></button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ---- controls ---- */}
      {insurance && (
        <div className="rounded-2xl border border-primary/40 bg-primary/10 p-3 text-center space-y-2">
          <p className="text-sm font-bold text-primary">Dealer shows an Ace — insurance?</p>
          <p className="text-[11px] text-white/60">Insurance costs half your bet and pays 2:1 if the dealer has blackjack.</p>
          <div className="flex gap-2">
            <button onClick={() => insure(true)} disabled={busy} className="flex-1 rounded-xl bg-primary text-primary-foreground font-bold py-2.5 min-h-[44px] active:scale-95 disabled:opacity-50">Insure</button>
            <button onClick={() => insure(false)} disabled={busy} className="flex-1 rounded-xl border border-white/20 bg-white/5 text-white font-bold py-2.5 min-h-[44px] active:scale-95 disabled:opacity-50">No</button>
          </div>
        </div>
      )}

      {playing && activeHand && (
        <div className="grid grid-cols-2 gap-2">
          <button onClick={() => act("hit")} disabled={busy} className="rounded-xl bg-[hsl(var(--emerald))] text-black font-extrabold py-3 min-h-[48px] active:scale-95 disabled:opacity-50">HIT</button>
          <button onClick={() => act("stand")} disabled={busy} className="rounded-xl bg-[hsl(var(--magenta))] text-white font-extrabold py-3 min-h-[48px] active:scale-95 disabled:opacity-50">STAND</button>
          <button onClick={() => act("double")} disabled={busy || !activeHand.can_double} className="rounded-xl border-2 border-primary/60 bg-primary/10 text-primary font-extrabold py-2.5 min-h-[44px] active:scale-95 disabled:opacity-40">DOUBLE</button>
          <button onClick={() => act("split")} disabled={busy || !activeHand.can_split} className="rounded-xl border-2 border-white/25 bg-white/5 text-white font-extrabold py-2.5 min-h-[44px] active:scale-95 disabled:opacity-40">SPLIT</button>
        </div>
      )}

      {betting && (
        <div className="space-y-2">
          <div className="flex items-center gap-1.5 flex-wrap">
            {CHIPS.map((c) => (
              <button key={c.v} onClick={() => setChip(c.v)} aria-label={`Chip ${c.v}`}
                className={`h-11 w-11 rounded-full font-extrabold text-[11px] tabular-nums border-4 border-dashed shadow transition-transform duration-100 ${chip === c.v ? "scale-110 ring-2 ring-primary" : "opacity-80 hover:opacity-100"}`}
                style={{ background: c.bg, color: c.fg, borderColor: "rgba(255,255,255,0.55)" }}>
                {c.v >= 1000 ? `${c.v / 1000}k` : c.v}
              </button>
            ))}
            <div className="flex-1" />
            {totalStake > 0 && <button onClick={clearBets} className="h-9 px-2.5 rounded-lg border border-white/15 bg-white/5 text-[11px] font-bold text-white/70 flex items-center gap-1"><RotateCcw className="h-3 w-3" />Clear</button>}
          </div>
          <button onClick={deal} disabled={busy || totalStake === 0} data-testid="blackjack-deal"
            className="w-full rounded-xl bg-primary text-primary-foreground font-extrabold text-base tracking-wide uppercase py-3.5 min-h-[52px] shadow-[0_8px_24px_rgba(255,199,64,0.4)] active:scale-[0.98] disabled:opacity-50">
            {totalStake > 0 ? `Shuffle & Deal · ${formatChips(totalStake)}` : "Place your bets"}
          </button>
        </div>
      )}

      {done && (
        <div className="space-y-2">
          <div className="rounded-2xl border border-white/10 bg-card/55 px-4 py-3 text-center">
            <p className="text-sm font-extrabold" style={{ color: state.net > 0 ? "#4ade80" : state.net < 0 ? "#fb7185" : "#a9bce0" }}>
              {state.net > 0 ? `You win +${formatChips(state.net)}` : state.net < 0 ? `Dealer takes ${formatChips(-state.net)}` : "Push — bets returned"}
            </p>
          </div>
          <button onClick={nextHand} data-testid="blackjack-next"
            className="w-full rounded-xl bg-primary text-primary-foreground font-extrabold text-base tracking-wide uppercase py-3.5 min-h-[52px] shadow-[0_8px_24px_rgba(255,199,64,0.4)] active:scale-[0.98] flex items-center justify-center gap-1">
            Next Hand <ChevronRight className="h-5 w-5" />
          </button>
        </div>
      )}
    </PlayShell>
  );
}
