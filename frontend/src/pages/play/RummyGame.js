import { Component, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { ArrowLeft, Check, Coins, Hand, Layers3, LogOut, MessageCircle, RotateCcw, Send, ShieldCheck, Volume2, VolumeX, X } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";

import { api, errCode, errMsg } from "@/lib/api";
import { formatChips } from "@/components/common";
import { isMuted, onMuteChange, sfx, toggleMuted } from "@/lib/sound";
import "./rummy.css";


const SUITS = {
  S: { symbol: "♠", red: false }, H: { symbol: "♥", red: true },
  D: { symbol: "♦", red: true }, C: { symbol: "♣", red: false },
};

const uuid = () => globalThis.crypto?.randomUUID?.() || `rummy-${Date.now()}-${Math.random().toString(16).slice(2)}`;
const RUMMY_POLL_MS = 900;
const RUMMY_POLL_MAX_MS = 8000;
const RUMMY_ART = {
  "--rummy-felt-art": "url('/game-art/rummy-felt.jpg')",
  "--rummy-avatar-art": "url('/game-art/rummy-avatar-atlas.jpg')",
  "--rummy-card-back-art": "url('/game-art/rummy-card-back.jpg')",
};

export function nextRummyPollDelay(previousDelay, succeeded) {
  if (succeeded) return RUMMY_POLL_MS;
  return Math.min(RUMMY_POLL_MAX_MS, Math.max(RUMMY_POLL_MS, Number(previousDelay) || RUMMY_POLL_MS) * 2);
}

function useSoundState() {
  const [muted, setMuted] = useState(isMuted());
  useEffect(() => onMuteChange(setMuted), []);
  return muted;
}

export function RummyCard({ card, selected, raised, onSelect, onDragStart, compact = false }) {
  if (!card) {
    return (
      <span className={`rummy-card rummy-card-placeholder ${compact ? "is-compact" : ""}`} aria-label="Card not dealt yet">
        <b>?</b>
      </span>
    );
  }
  const joker = card?.printedJoker || card?.code === "PJ";
  const suit = SUITS[card?.suit];
  const rank = joker ? "J" : String(card?.code || "").slice(0, -1);
  const Root = onSelect ? motion.button : motion.div;
  return (
    <Root
      {...(onSelect ? { type: "button" } : {})}
      layout
      draggable={Boolean(onDragStart)}
      onDragStart={(event) => onDragStart?.(event, card.id)}
      onClick={() => onSelect?.(card.id)}
      className={`rummy-card ${selected ? "is-selected" : ""} ${raised ? "is-raised" : ""} ${compact ? "is-compact" : ""}`}
      aria-pressed={selected}
      aria-label={joker ? "Printed joker" : `${rank} of ${card?.suit || "unknown suit"}`}
      data-card-id={card.id}
    >
      {joker ? (
        <><b className="rummy-joker-letter">J</b><span className="rummy-jester">♛</span><small>JOKER</small></>
      ) : (
        <>
          <span className={suit?.red ? "is-red" : ""}><b>{rank}</b><em>{suit?.symbol}</em></span>
          <strong className={suit?.red ? "is-red" : ""}>{suit?.symbol}</strong>
          <span className={`rummy-card-corner ${suit?.red ? "is-red" : ""}`}><b>{rank}</b><em>{suit?.symbol}</em></span>
        </>
      )}
    </Root>
  );
}

function CardBack({ count = 1 }) {
  return (
    <span className="rummy-card-back" aria-label={`${count} hidden cards`}>
      <i /><i /><b>{count > 1 ? count : ""}</b>
    </span>
  );
}

export function PlayerSeat({ seat, timer, reducedMotion, viewerSeatIndex }) {
  const active = seat?.active;
  const timerText = active && timer != null ? Math.max(0, Math.ceil(timer)) : null;
  const avatarKey = `${seat?.playerId || ""}:${seat?.displayName || ""}:${seat?.seatIndex || 0}`;
  const avatarIndex = [...avatarKey].reduce((sum, character) => sum + character.charCodeAt(0), 0) % 8;
  const avatarStyle = {
    "--avatar-x": `${(avatarIndex % 4) * 33.333}%`,
    "--avatar-y": `${Math.floor(avatarIndex / 4) * 100}%`,
  };
  return (
    <div className={`rummy-seat rummy-seat-${seat.seatIndex} ${active ? "is-active" : ""} is-${String(seat.status || "empty").toLowerCase()}`}>
      <div
        className="rummy-avatar-ring"
        style={active ? { "--turn-progress": Math.max(0.02, Math.min(1, Number(timer || 0) / 30)) } : undefined}
      >
        {seat.status === "EMPTY"
          ? <span className="rummy-face is-empty" aria-hidden>+</span>
          : <span className="rummy-face" style={avatarStyle} role="img" aria-label={`${seat.displayName} avatar`} />}
        {timerText != null && <b className="rummy-only-timer" aria-label={`${timerText} seconds remaining`}>{timerText}</b>}
      </div>
      <strong>{seat.status === "EMPTY" ? "Waiting" : seat.displayName}</strong>
      <small>{seat.status === "DROPPED" ? `Dropped · ${seat.droppedPoints || 0} pts` : seat.isBot ? "Practice bot" : seat.playerId}</small>
      {seat.cardCount > 0 && seat.seatIndex !== viewerSeatIndex && <CardBack count={seat.cardCount} />}
      {active && !reducedMotion && <span className="rummy-active-flare" aria-hidden />}
    </div>
  );
}

function Deck({ label, card, count, disabled, onClick, open = false }) {
  return (
    <button type="button" className={`rummy-deck ${open ? "is-open" : ""}`} disabled={disabled} onClick={onClick} aria-label={label}>
      {open && card ? <RummyCard card={card} compact /> : <CardBack count={count} />}
      <b>{label}</b>
    </button>
  );
}

function CategoryLobby({ categories, balance, busy, onJoin, onExit }) {
  return (
    <main className="rummy-lobby" data-testid="rummy-category-lobby">
      <header className="rummy-lobby-head">
        <button type="button" onClick={onExit} aria-label="Back to Rummy details"><ArrowLeft /></button>
        <img src="/game-art/rummy.png" alt="Rummy" />
        <div><Coins /><b>{formatChips(balance)}</b><span>chips</span></div>
      </header>
      <section className="rummy-lobby-copy">
        <span>LIVE MODE · FIVE-SEAT INDIAN RUMMY</span>
        <h1>Choose your royal table</h1>
        <p>Thirteen cards. Two sequences. One pure sequence. Every result is validated by the server.</p>
      </section>
      <section className="rummy-categories" aria-label="Rummy table categories">
        {categories.map((category, categoryIndex) => {
          const enough = Number(balance || 0) >= Number(category.minChipBalance);
          return (
            <article key={category.id} className={`rummy-category rummy-${category.id.toLowerCase()}`} style={{ "--cat-a": category.accent?.from, "--cat-b": category.accent?.to, "--cat-metal": category.accent?.metal, "--category-index": categoryIndex }}>
              <div className="rummy-category-level"><span>{category.id}</span><b>{category.displayName}</b></div>
              <div className="rummy-category-chip" aria-hidden><i /><strong>{formatChips(category.entryChips)}</strong></div>
              <dl>
                <div><dt>Entry</dt><dd>{formatChips(category.entryChips)} chips</dd></div>
                <div><dt>Point value</dt><dd>{formatChips(category.pointsValue)} chips</dd></div>
                <div><dt>Turn</dt><dd>{category.turnDurationSeconds}s</dd></div>
              </dl>
              <div className="rummy-category-actions">
                <button type="button" disabled={busy || !enough} onClick={() => onJoin(category.id, "LIVE")}>JOIN LIVE</button>
                <button type="button" disabled={busy} onClick={() => onJoin(category.id, "PRACTICE")}>PRACTICE FREE</button>
              </div>
              {!enough && <small>Live requires {formatChips(category.minChipBalance)} chips · practice is wallet-neutral</small>}
            </article>
          );
        })}
      </section>
      <footer><ShieldCheck /> Virtual chips only · secure server shuffle · no cash or currency</footer>
    </main>
  );
}

function Results({ result, onLobby }) {
  const reducedMotion = useReducedMotion();
  return (
    <motion.section className="rummy-results" role="dialog" aria-modal="true" aria-labelledby="rummy-result-title" initial={{ opacity: 0, scale: .92 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: reducedMotion ? 0 : .38, ease: [.22, 1, .36, 1] }}>
      {!reducedMotion && <div className="rummy-win-burst" aria-hidden>{Array.from({ length: 22 }, (_, index) => <motion.i key={index} style={{ "--burst-x": `${(index * 47) % 100}%`, "--burst-hue": `${38 + (index % 4) * 17}` }} initial={{ y: -80, rotate: index * 19, opacity: 0 }} animate={{ y: "108vh", rotate: index * 19 + 420, opacity: [0, 1, 1, 0] }} transition={{ duration: 2.4 + (index % 5) * .22, delay: (index % 9) * .07, ease: "linear", repeat: 1 }} />)}</div>}
      <motion.div className="rummy-result-halo" aria-hidden initial={{ scale: .45, opacity: 0 }} animate={{ scale: 1, opacity: .78 }} transition={{ duration: reducedMotion ? 0 : .62, ease: "easeOut" }} />
      <div className="rummy-result-ribbon"><span>ROYAL RESULT</span></div>
      <h2 id="rummy-result-title">{result.winnerName} wins</h2>
      <p>{formatChips(result.payoutChips)} chips · {String(result.reason || "").replaceAll("_", " ")}</p>
      <div className="rummy-result-rows">
        {(result.rows || []).map((row) => (
          <article key={row.seatIndex} className={row.status === "WON" ? "is-winner" : ""}>
            <div><b>Seat {row.seatIndex + 1} · {row.displayName}</b><span>{row.status} · {row.points} pts</span></div>
            <strong>{row.chipDelta >= 0 ? "+" : ""}{formatChips(row.chipDelta)} chips</strong>
            <div className="rummy-result-cards">
              {(row.cards || []).map((card) => <RummyCard key={card.id} card={card} compact />)}
            </div>
          </article>
        ))}
      </div>
      <button type="button" onClick={onLobby}>BACK TO LOBBY</button>
    </motion.section>
  );
}

function RummyTable({ game, state, busy, reconnecting, sendAction, onExit }) {
  const reducedMotion = useReducedMotion();
  const muted = useSoundState();
  const [selected, setSelected] = useState([]);
  const [groups, setGroups] = useState([]);
  const [dropOpen, setDropOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [chatDraft, setChatDraft] = useState("");
  const [sendingChat, setSendingChat] = useState(false);
  const lastRoundRef = useRef(null);
  const chatEndRef = useRef(null);
  const privateState = state.privateState;
  const seats = Array.from({ length: 5 }, (_, seatIndex) => (
    state.seats?.find((seat) => seat?.seatIndex === seatIndex)
    || { seatIndex, status: "EMPTY", cardCount: 0 }
  ));
  const cards = useMemo(() => privateState?.cards || [], [privateState?.cards]);
  const cardIds = useMemo(() => new Set(cards.map((card) => card.id)), [cards]);

  useEffect(() => {
    if (lastRoundRef.current !== state.roundId) {
      lastRoundRef.current = state.roundId;
      setGroups(privateState?.groups || []);
      setSelected([]);
    } else {
      setGroups((current) => current.map((group) => group.filter((id) => cardIds.has(id))).filter((group) => group.length));
      setSelected((current) => current.filter((id) => cardIds.has(id)));
    }
  }, [cardIds, privateState?.groups, state.roundId]);

  const cardMap = useMemo(() => Object.fromEntries(cards.map((card) => [card.id, card])), [cards]);
  const groupedIds = useMemo(() => new Set(groups.flat()), [groups]);
  const ungrouped = cards.filter((card) => !groupedIds.has(card.id));
  const mySeat = seats.find((seat) => seat.playerId && !seat.isBot && seat.seatIndex === privateState?.seatIndex) || seats[0];

  const toggleCard = (cardId) => setSelected((current) => current.includes(cardId) ? current.filter((id) => id !== cardId) : [...current, cardId]);
  const autoSort = () => {
    const suggested = (privateState?.suggestedGroups || []).map((row) => row.cardIds);
    const used = new Set(suggested.flat());
    const rest = cards.filter((card) => !used.has(card.id)).sort((a, b) => a.suit.localeCompare(b.suit) || a.rank - b.rank).map((card) => card.id);
    setGroups([...suggested, ...(rest.length ? [rest] : [])]);
    setSelected([]);
    sfx.flick?.();
  };
  const groupSelected = async () => {
    if (selected.length < 2) return toast.info("Select at least two cards to make a group");
    const next = [...groups.map((group) => group.filter((id) => !selected.includes(id))).filter((group) => group.length), selected];
    setGroups(next); setSelected([]);
    await sendAction("GROUP", { groups: next });
  };
  const ungroupSelected = async () => {
    if (!selected.length) return;
    const next = groups.map((group) => group.filter((id) => !selected.includes(id))).filter((group) => group.length);
    setGroups(next); setSelected([]);
    await sendAction("GROUP", { groups: next });
  };
  const dropInto = async (groupIndex, cardId) => {
    const next = groups.map((group) => group.filter((id) => id !== cardId));
    if (!next[groupIndex]) next[groupIndex] = [];
    next[groupIndex].push(cardId);
    setGroups(next.filter((group) => group.length));
    await sendAction("GROUP", { groups: next.filter((group) => group.length) });
  };
  const discard = async () => {
    if (selected.length !== 1) return toast.info("Select exactly one card to discard");
    await sendAction("DISCARD", { cardId: selected[0] });
    setSelected([]);
  };
  const declare = async () => sendAction("DECLARE", { groups });
  const sendChat = async (event) => {
    event.preventDefault();
    const body = chatDraft.trim();
    if (!body || sendingChat) return;
    setSendingChat(true);
    try {
      await api.post(`/games/rummy/rooms/${state.roomId}/chat`, { body }, { timeout: 12000 });
      setChatDraft("");
    } catch (error) {
      toast.error(errMsg(error, "That table message could not be sent."));
    } finally {
      setSendingChat(false);
    }
  };

  useEffect(() => {
    if (chatOpen) chatEndRef.current?.scrollIntoView({ block: "nearest" });
  }, [chatOpen, state.chat]);

  const status = state.state === "WAITING_FOR_PLAYERS"
    ? `Waiting for ${5 - seats.filter((seat) => seat.status !== "EMPTY").length} more players`
    : state.currentSeat === mySeat?.seatIndex
      ? privateState?.drawn ? "Choose one card to discard" : "Your turn · draw from either pile"
      : `${seats.find((seat) => seat.seatIndex === state.currentSeat)?.displayName || "Player"}'s turn`;

  return (
    <main className="rummy-game" style={RUMMY_ART} data-testid="rummy-live-table" data-state={state.state} data-mode={state.mode}>
      <header className="rummy-game-head">
        <button type="button" onClick={onExit} aria-label="Leave Rummy"><ArrowLeft /></button>
        <div className="rummy-brand-lockup"><span className="rummy-brand-monogram" aria-hidden>R</span><span><b>RUMMY</b><small>13-CARD CLASSIC</small></span></div>
        <div className="rummy-live-pill"><i />{state.mode === "PRACTICE" ? "PRACTICE MODE" : "LIVE MODE"}</div>
        <div className="rummy-balance"><Coins /><b>{formatChips(state.balance)}</b><span>chips</span></div>
        <button type="button" className="rummy-chat-toggle" onClick={() => setChatOpen((open) => !open)} aria-label="Open table chat"><MessageCircle /></button>
        <button type="button" onClick={toggleMuted} aria-label={muted ? "Turn Rummy sound on" : "Mute Rummy sound"}>{muted ? <VolumeX /> : <Volume2 />}</button>
      </header>

      <section className="rummy-stage">
        <div className="rummy-status" aria-live="polite">{status}</div>
        <div className="rummy-table" aria-label="Five-seat Rummy table">
          {seats.map((seat) => <PlayerSeat key={seat.seatIndex} seat={seat} timer={seat.active ? state.turnEndsIn : null} reducedMotion={reducedMotion} viewerSeatIndex={privateState?.seatIndex} />)}
          <div className="rummy-piles">
            <Deck label="CLOSED DECK" count={state.closedDeckCount} disabled={busy || !privateState?.canDraw} onClick={() => sendAction("DRAW_CLOSED")} />
            <Deck label="OPEN CARD" card={state.openDiscard} open disabled={busy || !privateState?.canDraw || !state.openDiscard} onClick={() => sendAction("DRAW_DISCARD")} />
            <div className="rummy-wild"><RummyCard card={state.wildJoker} compact /><span>WILD JOKER</span></div>
          </div>
        </div>

        {privateState && (
          <section className="rummy-hand-zone" aria-label="Your thirteen-card hand">
            <div className="rummy-group-rail">
              {groups.map((group, index) => (
                <div
                  key={`group-${index}`}
                  className="rummy-group"
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => { event.preventDefault(); const id = event.dataTransfer.getData("text/rummy-card"); if (id) dropInto(index, id); }}
                >
                  <span>{index === 0 ? "GROUP 1" : `GROUP ${index + 1}`}</span>
                  <div>{group.map((id) => cardMap[id] && <RummyCard key={id} card={cardMap[id]} selected={selected.includes(id)} raised={privateState.drawnCardId === id} onSelect={toggleCard} onDragStart={(event, cardId) => event.dataTransfer.setData("text/rummy-card", cardId)} />)}</div>
                </div>
              ))}
              {ungrouped.length > 0 && (
                <div className="rummy-group is-ungrouped"><span>UNGROUPED</span><div>{ungrouped.map((card) => <RummyCard key={card.id} card={card} selected={selected.includes(card.id)} raised={privateState.drawnCardId === card.id} onSelect={toggleCard} onDragStart={(event, cardId) => event.dataTransfer.setData("text/rummy-card", cardId)} />)}</div></div>
              )}
            </div>
            <div className="rummy-actions">
              <button type="button" onClick={autoSort} disabled={busy}><RotateCcw />AUTO SORT</button>
              <button type="button" onClick={groupSelected} disabled={busy || selected.length < 2}><Layers3 />GROUP</button>
              <button type="button" onClick={ungroupSelected} disabled={busy || !selected.length}><X />UNGROUP</button>
              <button type="button" className="is-drop" onClick={() => setDropOpen(true)} disabled={busy}><LogOut />DROP</button>
              <button type="button" className="is-discard" onClick={discard} disabled={busy || !privateState.canDiscard || selected.length !== 1}><Hand />DISCARD</button>
              <button type="button" className="is-declare" onClick={declare} disabled={busy || !privateState.canDeclare}><Check />DECLARE</button>
            </div>
          </section>
        )}
      </section>

      {reconnecting && <div className="rummy-reconnecting" role="status"><RotateCcw />Reconnecting to the authoritative table…</div>}
      <AnimatePresence>{chatOpen && (
        <motion.aside
          className="rummy-chat"
          aria-label="Table chat"
          initial={reducedMotion ? { opacity: 0 } : { opacity: 0, x: 28 }}
          animate={{ opacity: 1, x: 0 }}
          exit={reducedMotion ? { opacity: 0 } : { opacity: 0, x: 28 }}
        >
          <header><div><MessageCircle /><span><b>TABLE CHAT</b><small>Room members only</small></span></div><button type="button" onClick={() => setChatOpen(false)} aria-label="Close chat"><X /></button></header>
          <div className="rummy-chat-messages">
            {(state.chat || []).length === 0 && <p>Say hello to the table. Messages disappear after 24 hours.</p>}
            {(state.chat || []).map((message) => (
              <article key={message.id} className={message.seatIndex === privateState?.seatIndex ? "is-mine" : ""}>
                <span>Seat {Number(message.seatIndex) + 1}</span>
                <b>{message.displayName || "Player"}</b>
                <p>{message.body}</p>
              </article>
            ))}
            <i ref={chatEndRef} />
          </div>
          <div className="rummy-chat-quick" aria-label="Quick messages">
            {["Good luck!", "Nice move", "Well played"].map((text) => <button type="button" key={text} onClick={() => setChatDraft(text)}>{text}</button>)}
          </div>
          <form onSubmit={sendChat}><label htmlFor="rummy-chat-message">Message</label><input id="rummy-chat-message" value={chatDraft} onChange={(event) => setChatDraft(event.target.value)} maxLength={180} placeholder="Message the table…" /><button type="submit" disabled={sendingChat || !chatDraft.trim()} aria-label="Send message"><Send /></button></form>
        </motion.aside>
      )}</AnimatePresence>
      <AnimatePresence>{state.result && <Results result={state.result} onLobby={onExit} />}</AnimatePresence>
      <AnimatePresence>{dropOpen && (
        <motion.div className="rummy-confirm" role="dialog" aria-modal="true" aria-labelledby="rummy-drop-title" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
          <div><h2 id="rummy-drop-title">Drop this hand?</h2><p>The server will apply the configured first- or middle-drop points.</p><button type="button" onClick={() => setDropOpen(false)}>KEEP PLAYING</button><button type="button" className="is-danger" onClick={async () => { setDropOpen(false); await sendAction("DROP"); }}>DROP HAND</button></div>
        </motion.div>
      )}</AnimatePresence>
    </main>
  );
}

class RummyTableBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error) {
    console.error("Rummy table render recovered", error);
  }

  componentDidUpdate(previousProps) {
    if (this.state.failed && previousProps.state?.version !== this.props.state?.version) {
      this.setState({ failed: false });
    }
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="rummy-game rummy-recovery" role="alert">
        <section>
          <span>TABLE RECOVERY</span>
          <h1>The room did not finish loading.</h1>
          <p>Your chips are safe. Return to the lobby and reconnect to a fresh authoritative table.</p>
          <button type="button" onClick={this.props.onExit}><ArrowLeft /> RETURN TO RUMMY LOBBY</button>
        </section>
      </main>
    );
  }
}

export default function RummyGame({ game }) {
  const navigate = useNavigate();
  const [categories, setCategories] = useState([]);
  const [balance, setBalance] = useState(0);
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const roomRef = useRef(null);
  const actionInFlightRef = useRef(false);
  const pollInFlightRef = useRef(false);
  const pollAbortRef = useRef(null);

  const acceptAuthoritativeState = useCallback((next) => {
    if (!next?.roomId) return false;
    const current = roomRef.current;
    if (
      current?.roomId === next.roomId
      && Number(next.version) < Number(current.version)
    ) return false;
    roomRef.current = next;
    setState(next);
    return true;
  }, []);

  const loadLobby = useCallback(async () => {
    try {
      const [{ data: categoryData }, { data: balanceData }] = await Promise.all([
        api.get("/games/rummy/categories"), api.get("/chips/balance"),
      ]);
      setCategories(categoryData.categories || []);
      setBalance(balanceData.balance || 0);
    } catch (error) {
      toast.error(errMsg(error, "Rummy lobby could not be loaded."));
    }
  }, []);
  useEffect(() => { loadLobby(); }, [loadLobby]);
  useEffect(() => { roomRef.current = state; }, [state]);

  const join = async (categoryId, mode) => {
    if (actionInFlightRef.current) return;
    actionInFlightRef.current = true;
    setBusy(true);
    try {
      const { data } = await api.post("/games/rummy/join", { categoryId, mode }, { timeout: 22000 });
      acceptAuthoritativeState(data); setBalance(data.balance ?? balance); sfx.deal?.();
    } catch (error) {
      toast.error(errMsg(error, "The Rummy table could not be joined."));
    } finally { actionInFlightRef.current = false; setBusy(false); }
  };

  const sendAction = useCallback(async (actionType, actionPayload = {}) => {
    const current = roomRef.current;
    if (!current || actionInFlightRef.current) return null;
    actionInFlightRef.current = true;
    // A mutation always owns the transport lane. Abort an older GET so its
    // equal-version private payload cannot overwrite this acknowledgement.
    pollAbortRef.current?.abort();
    setBusy(true);
    try {
      const { data } = await api.post(`/games/rummy/rooms/${current.roomId}/actions`, {
        roomId: current.roomId, roundId: current.roundId, actionId: uuid(),
        expectedVersion: current.version, actionType, actionPayload,
        clientTimestamp: Date.now() / 1000,
      }, { timeout: 22000 });
      const next = data.state || { ...data.publicState, privateState: data.privateState };
      acceptAuthoritativeState(next); setReconnecting(false);
      if (actionType.startsWith("DRAW")) sfx.flick?.();
      if (actionType === "DISCARD") sfx.deal?.();
      if (data.code === "VALID_DECLARATION") { sfx.win?.(); sfx.cheer?.(true); }
      else if (String(data.code).includes("INVALID")) sfx.lose?.();
      return next;
    } catch (error) {
      if (["RUMMY_STALE_VERSION", "RUMMY_STALE_ROUND"].includes(errCode(error))) setReconnecting(true);
      toast.error(errMsg(error, "The table rejected that action."));
      return null;
    } finally { actionInFlightRef.current = false; setBusy(false); }
  }, [acceptAuthoritativeState]);

  useEffect(() => {
    if (!state?.roomId || state.state === "ROUND_SETTLED" || state.state === "CANCELLED") return undefined;
    let active = true;
    let timer = null;
    let delay = RUMMY_POLL_MS;
    const schedule = (wait) => {
      if (active) timer = window.setTimeout(poll, wait);
    };
    const poll = async () => {
      if (!active) return;
      if (pollInFlightRef.current || actionInFlightRef.current) {
        schedule(150);
        return;
      }
      pollInFlightRef.current = true;
      const controller = new AbortController();
      pollAbortRef.current = controller;
      let succeeded = false;
      try {
        const roomId = roomRef.current?.roomId;
        if (!roomId) return;
        const { data } = await api.get(`/games/rummy/rooms/${roomId}/state`, {
          timeout: 12000, signal: controller.signal,
        });
        if (!active) return;
        const previous = roomRef.current;
        if (!acceptAuthoritativeState(data)) {
          succeeded = true;
          return;
        }
        succeeded = true;
        setReconnecting(false);
        if (data.result && !previous?.result) {
          data.result.winnerSeat === data.privateState?.seatIndex ? sfx.win?.() : sfx.lose?.();
        }
        const ownSeat = data.seats?.find((seat) => seat.seatIndex === data.privateState?.seatIndex);
        if (ownSeat?.status === "RECONNECTING") await sendAction("RECONNECT");
      } catch (error) {
        if (active && !controller.signal.aborted) setReconnecting(true);
      } finally {
        if (pollAbortRef.current === controller) pollAbortRef.current = null;
        pollInFlightRef.current = false;
        delay = nextRummyPollDelay(delay, succeeded);
        schedule(delay);
      }
    };
    schedule(0);
    return () => {
      active = false;
      window.clearTimeout(timer);
      pollAbortRef.current?.abort();
      pollAbortRef.current = null;
      pollInFlightRef.current = false;
    };
  }, [acceptAuthoritativeState, sendAction, state?.roomId, state?.state]);

  const exit = async () => {
    if (state && !state.result && state.state !== "CANCELLED") {
      await sendAction(state.state === "WAITING_FOR_PLAYERS" ? "LEAVE" : "DROP");
    }
    setState(null); roomRef.current = null; await loadLobby();
  };

  if (!state) return <CategoryLobby categories={categories} balance={balance} busy={busy} onJoin={join} onExit={() => navigate(`/games/${game.slug}`)} />;
  return (
    <RummyTableBoundary state={state} onExit={exit}>
      <RummyTable game={game} state={state} busy={busy} reconnecting={reconnecting} sendAction={sendAction} onExit={exit} />
    </RummyTableBoundary>
  );
}
