import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { api, errMsg } from "@/lib/api";
import { formatChips } from "@/components/common";
import { Cabinet, CAB_W, CAB_H } from "@/components/play/arcade/Cabinet";
import { at, atMid } from "@/components/play/arcade/parts";
import { Crest, Cap, Sparkle, Gem } from "./rouArt";
import "./roulette.css";

/**
 * Fun Roulette, matched to the machine.
 *
 * The felt is the reference's: the 0 and 00 column, twelve columns of three,
 * the three "2 To 1" boxes down the right, the dozens, then the outside row.
 * The wheel is drawn in perspective above it and the Wheel Zoom control does
 * what it does on the machine — enlarges it until it overlaps the felt.
 *
 * Composed in cabinet units like every other screen, rather than wrapping the
 * portrait roulette board. That board fits itself and hit-tests taps against
 * its own fit; drawing the felt here instead means one coordinate space, so a
 * chip lands where it was dropped without any of the scale-squared arithmetic
 * that once put them an inch out.
 */

/* Eight denominations in the machine's colours. */
const CHIPS = [
  [1, "linear-gradient(180deg,#3fbf68,#0f6a30)"],
  [5, "linear-gradient(180deg,#5a86e8,#12307c)"],
  [10, "linear-gradient(180deg,#e85a5a,#8a1220)"],
  [50, "linear-gradient(180deg,#f0d24a,#8a6a08)"],
  [100, "linear-gradient(180deg,#54cfe0,#0d5f74)"],
  [500, "linear-gradient(180deg,#e05ac4,#7a0f66)"],
  [1000, "linear-gradient(180deg,#f09a3a,#8a4a08)"],
  [5000, "linear-gradient(180deg,#4a58c8,#141a60)"],
];

/* The felt reads left to right in columns of three, top row highest. */
const GRID_ROWS = [
  [3, 6, 9, 12, 15, 18, 21, 24, 27, 30, 33, 36],
  [2, 5, 8, 11, 14, 17, 20, 23, 26, 29, 32, 35],
  [1, 4, 7, 10, 13, 16, 19, 22, 25, 28, 31, 34],
];

const RED = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);

/* The American pocket order, so the wheel shows the sequence the engine draws
   from rather than a decorative ring of numbers. */
const WHEEL_ORDER = ["0", "28", "9", "26", "30", "11", "7", "20", "32", "17", "5", "22", "34",
  "15", "3", "24", "36", "13", "1", "00", "27", "10", "25", "29", "12", "8", "19", "31", "18",
  "6", "21", "33", "16", "4", "23", "35", "14", "2"];

const colourOf = (p) => (p === "0" || p === "00" ? "green" : RED.has(Number(p)) ? "red" : "black");

/** A key for a bet, so laid chips can be totalled per box. */
const keyOf = (type, value) => `${type}:${value}`;

/* Where the number grid actually sits, in cabinet units. The line zones below
   are computed from these rather than measured off the rendered grid, so the
   boundaries cannot drift away from the cells they divide. */
const GX = 120, GY = 424, GW = 1330, GH = 174;
const COL_W = GW / 12, ROW_H = GH / 3;

const LINE_ZONES = (() => {
  const zones = [];
  const push = (type, nums, x, y) => zones.push({ type, value: nums.join("-"), x, y });
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 12; c++) {
      const n = GRID_ROWS[r][c];
      // split with the number to the left
      if (c > 0) push("split", [GRID_ROWS[r][c - 1], n], GX + c * COL_W, GY + (r + 0.5) * ROW_H);
      // split with the number below
      if (r < 2) push("split", [n, GRID_ROWS[r + 1][c]], GX + (c + 0.5) * COL_W, GY + (r + 1) * ROW_H);
      // the corner of four
      if (c > 0 && r < 2) {
        push("corner", [GRID_ROWS[r][c - 1], n, GRID_ROWS[r + 1][c - 1], GRID_ROWS[r + 1][c]],
             GX + c * COL_W, GY + (r + 1) * ROW_H);
      }
    }
    void r;
  }
  for (let c = 0; c < 12; c++) {
    // the street of three, on the bottom edge of its column
    push("street", [GRID_ROWS[0][c], GRID_ROWS[1][c], GRID_ROWS[2][c]], GX + (c + 0.5) * COL_W, GY + GH);
    // the six-line, on the bottom edge between two columns
    if (c > 0) {
      push("sixline", [GRID_ROWS[0][c - 1], GRID_ROWS[1][c - 1], GRID_ROWS[2][c - 1],
                       GRID_ROWS[0][c], GRID_ROWS[1][c], GRID_ROWS[2][c]], GX + c * COL_W, GY + GH);
    }
  }
  return zones;
})();

export default function RouletteCabinet({ game }) {
  const navigate = useNavigate();
  const [state, setState] = useState(null);
  const [chip, setChip] = useState(10);
  const [zoom, setZoom] = useState(true);
  const [busy, setBusy] = useState(false);
  const lastRef = useRef([]);

  const load = useCallback(async () => {
    try {
      const { data } = await api.get("/games/fun-roulette/state");
      setState(data);
      if (data.settled) lastRef.current = data.settled;
    } catch (e) { /* the poll below tries again */ }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 1000);
    return () => clearInterval(t);
  }, [load]);

  const betting = state?.phase === "BETTING";
  const staked = useMemo(() => {
    const m = {};
    (state?.my_bets || []).forEach((b) => {
      const k = keyOf(b.bet_type, b.value);
      m[k] = (m[k] || 0) + b.amount;
    });
    return m;
  }, [state]);

  const lay = async (bet_type, value) => {
    if (!betting || busy) return;
    setBusy(true);
    try {
      const { data } = await api.post("/games/fun-roulette/bets", { bet_type, value, amount: chip });
      setState((s) => (s ? { ...s, my_bets: data.my_bets, my_total: data.my_total } : s));
    } catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };

  const clearBets = async () => {
    if (!betting || busy) return;
    setBusy(true);
    try {
      await api.post("/games/fun-roulette/bets/clear");
      load();
    } catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };

  const winning = state?.winning_number;
  const settled = state?.settled;
  const spinning = state?.phase === "SPINNING";

  /* The wheel turns until the winning pocket is under the marker at the top.
     The angle is computed from the number the server has already chosen, and
     several whole turns are added so it reads as a spin rather than a jump —
     the outcome exists before the animation does, and the animation has to
     agree with it. The ring is what turns; the ball stays under the marker,
     which is how a real wheel reads from the player's seat. */
  const STEP = 360 / WHEEL_ORDER.length;
  const [ring, setRing] = useState(0);
  const spunFor = useRef(null);
  useEffect(() => {
    if (winning == null) { spunFor.current = null; return; }
    const rn = state?.round_number;
    if (spunFor.current === rn) return;
    spunFor.current = rn;
    const idx = Math.max(0, WHEEL_ORDER.indexOf(String(winning)));
    /* Always forward, and always at least six turns past wherever it stopped
       last time, so consecutive rounds never look like the wheel jerked back. */
    setRing((prev) => {
      const target = -idx * STEP;
      const turns = Math.ceil((prev + 360 * 6 - target) / 360);
      return target + turns * 360;
    });
  }, [winning, state?.round_number, STEP]);

  const message = (() => {
    if (state?.phase === "SPINNING") return "No more bets. The wheel is spinning…";
    if (settled) {
      return settled.payout > 0
        ? `Number ${settled.winning_number} — You Won ${formatChips(settled.payout)}`
        : `Number ${settled.winning_number} — no win this round.`;
    }
    if (state?.my_total) return "Your Bet Has Been Accepted.";
    return "FOR AMUSEMENT ONLY NO CASH VALUE.";
  })();

  /* A betting box. Everything on the felt is one of these, so a chip badge and
     the disabled state are written once. */
  const Cell = ({ type, value, style, className = "", children, testId }) => {
    const amount = staked[keyOf(type, value)];
    const hit = winning != null && type === "straight" && String(value) === String(winning);
    return (
      <button type="button" disabled={!betting || busy} onClick={() => lay(type, value)}
        data-testid={testId} className={`rou-cell ${hit ? "hit" : ""} ${className}`}
        style={{ ...style, opacity: betting ? 1 : 0.82, cursor: betting ? "pointer" : "default" }}>
        {children}
        {amount > 0 && <span className="rou-laid">{formatChips(amount)}</span>}
      </button>
    );
  };

  /* The box is square and the disc is laid back inside it, so the flattening is
     the perspective's doing rather than a height picked to look right. A disc
     rotated 58 degrees covers about 55% of its box, which is what sets the top. */
  /* The machine pushes in on the wheel for the spin and pulls back once the
     number is known — which is the whole of the drama, and the reason the
     reference has a zoomed and an unzoomed frame of the same table. */
  const wide = zoom || spinning;
  const wheelSize = wide ? 470 : 360;
  const wheelTop = wide ? -22 : 30;

  return (
    <Cabinet ground="#01120a" exitTo={`/games/${game.slug}`} testId="cab-fun-roulette" className="rou">
      <div className="rou-ground" aria-hidden="true" />
      <div className="rou-damask" aria-hidden="true" />

      {/* the crest across the top of the table */}
      <div className="rou-crest"><Crest w={CAB_W} opacity={0.55} /></div>

      <div className="rou-titlebar" style={atMid(CAB_W, 460, 8)}>
        <span className="rou-title">Fun Roulette</span>
        <Gem size={30} />
      </div>

      {/* ---- score, time --------------------------------------------------- */}
      <div style={at(56, 44, 360)}>
        <div className="rou-label">Score</div>
        <div className="rou-capped">
          <Sparkle size={26} style={{ left: -6, top: -4 }} />
          <div className="rou-plaque">{state ? formatChips(state.balance) : "…"}</div>
          <Sparkle size={22} style={{ right: -4, top: -6 }} />
        </div>
      </div>

      <div className="rou-capped" style={at(56, 132, 360)} data-testid="rou-time">
        <Cap h={44} flip />
        <div className="rou-plaque rou-time">
          {`0 : ${Math.max(0, Math.ceil(state?.phase_ends_in ?? 0))}`}
        </div>
        <Cap h={44} />
        <Sparkle size={22} style={{ left: 2, top: -8 }} />
      </div>

      {/* ---- winner, history, zoom ----------------------------------------- */}
      <div style={at(CAB_W - 56 - 360, 44, 360)}>
        <div className="rou-label">Winner</div>
        <div className="rou-capped">
          <Sparkle size={22} style={{ left: -4, top: -6 }} />
          <div className="rou-plaque">{formatChips(settled?.payout || 0)}</div>
          <Sparkle size={26} style={{ right: -6, top: -4 }} />
        </div>
      </div>

      <div className="rou-capped" style={at(CAB_W - 56 - 360, 132, 360)} data-testid="rou-history">
        <Cap h={44} flip />
        <div className="rou-plaque rou-history">
          {(state?.last_results || []).slice(0, 5).map((r, i) => (
            <span key={i} className={r.color === "red" ? "hot" : ""}>{r.winning_number}</span>
          ))}
        </div>
        <Cap h={44} />
        <Sparkle size={22} style={{ right: 2, top: -8 }} />
      </div>

      <div className="rou-capped" style={at(CAB_W - 56 - 340, 190, 340)}>
        <Cap h={36} flip />
        <button type="button" onClick={() => setZoom((z) => !z)} data-testid="rou-zoom"
          className="rou-btn" style={{ flex: 1, height: 34, fontSize: 19 }}>
          Wheel Zoom: {zoom ? "ON" : "OFF"}
        </button>
        <Cap h={36} />
      </div>

      {/* ---- the chips, two rows on the left -------------------------------- */}
      <div style={{ ...at(50, 196, 344), display: "flex", flexWrap: "wrap", gap: 22, rowGap: 14 }}>
        {CHIPS.map(([c, bg]) => (
          <button key={c} type="button" onClick={() => setChip(c)} aria-pressed={chip === c}
            data-testid={`rou-chip-${c}`} className={`rou-chip ${chip === c ? "on" : ""}`}
            style={{ background: bg }}>
            {c}
          </button>
        ))}
      </div>

      <button type="button" onClick={clearBets} disabled={!betting || !state?.my_total}
        data-testid="rou-clear-specific" className="rou-btn" style={at(50, 300, 344, 32)}>
        Cancel Specific Bet
      </button>

      {/* ---- take / bet ok / cancel ----------------------------------------- */}
      <div className="rou-capped" style={at(CAB_W - 56 - 380, 240, 180)}>
        <Cap h={34} flip />
        <button type="button" disabled className="rou-btn" style={{ flex: 1, height: 32 }}>Take</button>
        <Cap h={34} />
      </div>
      <div className="rou-capped" style={at(CAB_W - 56 - 180, 240, 180)}>
        <Cap h={34} flip />
        <button type="button" disabled={!betting} className="rou-btn"
          style={{ flex: 1, height: 32 }} data-testid="rou-bet-ok">Bet Ok</button>
        <Cap h={34} />
      </div>
      <button type="button" onClick={clearBets} disabled={!betting || !state?.my_total}
        data-testid="rou-clear" className="rou-btn" style={at(CAB_W - 56 - 340, 286, 340, 32)}>
        Cancel Bet
      </button>

      {/* ---- the wheel ------------------------------------------------------ */}
      <div className="rou-wheel-wrap" style={atMid(CAB_W, wheelSize, wheelTop, wheelSize)}
           data-testid="rou-wheel">
        <div className="rou-wheel">
          <div className="rou-wheel-bowl" />
          <div className="rou-wheel-rim" />
          <div className="rou-wheel-chrome">
            {Array.from({ length: 16 }, (_, i) => (
              <span key={i} className="rou-stud"
                style={{ transform: `rotate(${i * 22.5}deg) translateY(-${wheelSize * 0.395}px)` }} />
            ))}
          </div>
          <div className="rou-wheel-track" style={{
            transform: `rotate(${ring}deg)`,
            transition: spinning ? "transform 9s cubic-bezier(.12,.62,.12,1)"
                                 : "transform 1.2s cubic-bezier(.2,.7,.2,1)",
            background: `conic-gradient(${WHEEL_ORDER.map((p, i) => {
              const a = (360 / WHEEL_ORDER.length);
              const c = colourOf(p) === "green" ? "#0f8a3c" : colourOf(p) === "red" ? "#c01526" : "#101018";
              return `${c} ${i * a}deg ${(i + 1) * a}deg`;
            }).join(",")})`,
          }}>
            {WHEEL_ORDER.map((p, i) => {
              const a = (360 / WHEEL_ORDER.length) * i + (360 / WHEEL_ORDER.length) / 2;
              return (
                <span key={p} className="rou-pocket"
                  style={{ fontSize: wheelSize * 0.038,
                           transform: `translate(-50%,-50%) rotate(${a}deg) translateY(-${wheelSize * 0.335}px)` }}>
                  {p}
                </span>
              );
            })}
          </div>
          <div className="rou-wheel-cone" />
          <div className="rou-wheel-cross">
            {[0, 45, 90, 135].map((a) => (
              <span key={a} style={{ transform: `rotate(${a}deg)` }} />
            ))}
          </div>
          <div className="rou-wheel-hubplate" />
          <div className="rou-wheel-gem" />
          {/* The marker and the ball both live at the top; the ring brings the
              number to them. */}
          <div className="rou-marker" />
          {winning != null && (
            <div className="rou-ball" style={{ top: `${50 - 39.5}%`, left: "50%" }} />
          )}
        </div>
      </div>

      {/* ---- the felt -------------------------------------------------------- */}
      {/* the double gold rule the machine draws round the whole betting area */}
      <div className="rou-feltframe" style={at(36, 422, CAB_W - 72, 270)} />
      {/* 0 / 00 */}
      <div style={at(38, 424, 82, 174)}>
        {["00", "0"].map((z, i) => (
          <Cell key={z} type="straight" value={z} testId={`rou-num-${z}`}
            style={{ height: 87, width: "100%" }}>
            <span className="rou-disc green" style={{ height: 46, width: 46, fontSize: 22 }}>{z}</span>
          </Cell>
        ))}
      </div>

      {/* the three rows of twelve */}
      <div style={{ ...at(120, 424, 1330, 174), display: "grid",
                    gridTemplateColumns: "repeat(12, 1fr)", gridTemplateRows: "repeat(3, 1fr)" }}>
        {GRID_ROWS.flatMap((row) => row.map((n) => (
          <Cell key={n} type="straight" value={String(n)} testId={`rou-num-${n}`}>
            <span className={`rou-disc ${RED.has(n) ? "red" : "black"}`}>{n}</span>
          </Cell>
        )))}
      </div>

      {/* The line bets. A real table takes a chip on the boundary between
          numbers, and the engine settles split, street, corner and six-line —
          so the boundaries are live rather than decorative. Each zone is a
          small target laid over the ruled line it belongs to, above the number
          cells so the boundary wins the tap and the number keeps the rest. */}
      {LINE_ZONES.map((z) => {
        const amount = staked[keyOf(z.type, z.value)];
        return (
          <button key={`${z.type}:${z.value}`} type="button" disabled={!betting || busy}
            onClick={() => lay(z.type, z.value)} data-testid={`rou-${z.type}-${z.value}`}
            title={`${z.type} ${z.value.replace(/-/g, ", ")}`}
            className="rou-zone" style={at(z.x - 13, z.y - 13, 26, 26)}>
            {amount > 0 && <span className="rou-laid rou-laid-zone">{formatChips(amount)}</span>}
          </button>
        );
      })}

      {/* the column bets: the top row is column 3, the bottom is column 1 */}
      <div style={{ ...at(1450, 424, 112, 174), display: "grid", gridTemplateRows: "repeat(3, 1fr)" }}>
        {[3, 2, 1].map((col) => (
          <Cell key={col} type="column" value={col} testId={`rou-col-${col}`}>
            <span className="rou-outside" style={{ fontSize: 20, lineHeight: 1.1, textAlign: "center" }}>
              2<br />To<br />1
            </span>
          </Cell>
        ))}
      </div>

      {/* the dozens */}
      <div style={{ ...at(120, 598, 1330, 46), display: "grid", gridTemplateColumns: "repeat(3, 1fr)" }}>
        {[["1st 12", 1], ["2nd 12", 2], ["3rd 12", 3]].map(([label, d]) => (
          <Cell key={d} type="dozen" value={d} testId={`rou-dozen-${d}`}>
            <span className="rou-dozen">{label}</span>
          </Cell>
        ))}
      </div>

      {/* the outside row */}
      <div style={{ ...at(120, 644, 1330, 46), display: "grid", gridTemplateColumns: "repeat(6, 1fr)" }}>
        <Cell type="range" value="low" testId="rou-low"><span className="rou-outside">1 To 18</span></Cell>
        <Cell type="parity" value="even" testId="rou-even"><span className="rou-outside">Even</span></Cell>
        <Cell type="color" value="red" testId="rou-red">
          <span style={{ width: 34, height: 34, transform: "rotate(45deg)",
                         background: "radial-gradient(circle at 38% 30%, #e03a3a, #8a0f16 76%)",
                         border: "2px solid #d9c06a" }} />
        </Cell>
        <Cell type="color" value="black" testId="rou-black">
          <span style={{ width: 34, height: 34, transform: "rotate(45deg)",
                         background: "radial-gradient(circle at 38% 30%, #3a3a44, #08080e 76%)",
                         border: "2px solid #d9c06a" }} />
        </Cell>
        <Cell type="parity" value="odd" testId="rou-odd"><span className="rou-outside">Odd</span></Cell>
        <Cell type="range" value="high" testId="rou-high"><span className="rou-outside">19 To 36</span></Cell>
      </div>

      {/* ---- footer ---------------------------------------------------------- */}
      <div className="rou-total" style={at(38, 700, 130, 32)} data-testid="rou-total">
        {formatChips(state?.my_total || 0)}
      </div>
      <div className="rou-capped" style={at(180, 700, CAB_W - 360)}>
        <Cap h={38} flip />
        <div className="rou-footer" style={{ flex: 1, height: 32 }} data-testid="rou-message">{message}</div>
        <Cap h={38} />
      </div>
      <button type="button" onClick={() => navigate(`/games/${game.slug}`)} data-testid="rou-exit"
        className="rou-btn" style={at(CAB_W - 168, 700, 130, 32)}>Exit</button>
    </Cabinet>
  );
}
