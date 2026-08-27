import { Component, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, LayoutGroup, motion, useReducedMotion } from "framer-motion";
import { ArrowLeft, Check, Coins, Hand, Layers3, LogOut, RotateCcw, ShieldCheck, Volume2, VolumeX, X } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";

import { api, errCode, errMsg } from "@/lib/api";
import { formatChips } from "@/components/common";
import { ProfileAvatar } from "@/components/ProfileAvatar";
import { isMuted, onMuteChange, sfx, toggleMuted } from "@/lib/sound";
import {
  applyRummyDemoAction,
  createRummyDemoState,
  RUMMY_DEMO_BALANCE,
  RUMMY_DEMO_CATEGORIES,
} from "./rummyDemo";
import RummyAtmosphere, { RUMMY_ATMOSPHERE_PHASES } from "./RummyAtmosphere";
import { createRummyAudioController, RUMMY_AUDIO_CUES } from "./rummyAudio";
import { CategoryLobby } from "./RummyPremiumLobby";
import { RummyRoyalSettlement } from "./RummyRoyalSettlement";
import "./rummy.css";

export { CategoryLobby } from "./RummyPremiumLobby";
export { RummyRoyalSettlement as Results } from "./RummyRoyalSettlement";


const SUITS = {
  S: { symbol: "♠", red: false }, H: { symbol: "♥", red: true },
  D: { symbol: "♦", red: true }, C: { symbol: "♣", red: false },
};

const uuid = () => globalThis.crypto?.randomUUID?.() || `rummy-${Date.now()}-${Math.random().toString(16).slice(2)}`;
const RUMMY_POLL_MS = 900;
const RUMMY_POLL_MAX_MS = 8000;
const RUMMY_PALACE_ART = "/game-art/rummy/table-palace-v2.png";
const RUMMY_ART = {
  "--rummy-felt-art": "url('/game-art/rummy-felt.jpg')",
  "--rummy-avatar-art": "url('/game-art/rummy-avatar-atlas.jpg')",
  "--rummy-card-back-art": "url('/game-art/rummy-card-back.jpg')",
  "--rummy-palace-art": `url('${RUMMY_PALACE_ART}')`,
};
const RUMMY_JOIN_TRANSPORT_MESSAGE = "We could not reach the secure Rummy server. Check your connection, then retry this table.";
const readableRuleLabel = (value, fallback = "UNVALIDATED") => String(value || fallback).replaceAll("_", " ");
const groupSignature = (groups) => JSON.stringify(groups || []);
const MODAL_FOCUSABLE = "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";
const RUMMY_TABLE_CYCLE_SECONDS = 180;
const RUMMY_ACTIVE_SEAT_STATES = new Set(["ACTIVE", "RECONNECTING"]);
const RUMMY_EXIT_CONFIRMED_CODES = new Set([
  "RUMMY_NOT_A_MEMBER",
  "RUMMY_ROOM_NOT_FOUND",
  "RUMMY_SEAT_INACTIVE",
]);
const RUMMY_HANDHELD_MAX_PORTRAIT_WIDTH = 1024;
const RUMMY_PHONE_PORTRAIT_WIDTH = 600;

function getRummyViewport(targetWindow) {
  const viewport = targetWindow?.visualViewport;
  const width = Number(viewport?.width || targetWindow?.innerWidth || targetWindow?.document?.documentElement?.clientWidth || 0);
  const height = Number(viewport?.height || targetWindow?.innerHeight || targetWindow?.document?.documentElement?.clientHeight || 0);
  return { width, height };
}

export function shouldBlockRummyPortrait(targetWindow = typeof window === "undefined" ? null : window) {
  if (!targetWindow) return false;
  const { width, height } = getRummyViewport(targetWindow);
  if (!width || !height || height <= width || width > RUMMY_HANDHELD_MAX_PORTRAIT_WIDTH) return false;
  const touchCapable = Number(targetWindow.navigator?.maxTouchPoints || 0) > 0
    || Boolean(targetWindow.matchMedia?.("(hover: none) and (pointer: coarse)")?.matches);
  return touchCapable || width <= RUMMY_PHONE_PORTRAIT_WIDTH;
}

export async function requestRummyLandscape(targetWindow = typeof window === "undefined" ? null : window, { allowFullscreen = false } = {}) {
  const orientation = targetWindow?.screen?.orientation;
  if (!orientation?.lock) return { locked: false, enteredFullscreen: false };

  try {
    await orientation.lock("landscape");
    return { locked: true, enteredFullscreen: false };
  } catch {
    if (!allowFullscreen) return { locked: false, enteredFullscreen: false };
  }

  const targetDocument = targetWindow?.document;
  let enteredFullscreen = false;
  if (!targetDocument?.fullscreenElement && targetDocument?.documentElement?.requestFullscreen) {
    try {
      await targetDocument.documentElement.requestFullscreen();
      enteredFullscreen = true;
    } catch {
      return { locked: false, enteredFullscreen: false };
    }
  }

  try {
    await orientation.lock("landscape");
    return { locked: true, enteredFullscreen };
  } catch {
    return { locked: false, enteredFullscreen };
  }
}

export function RummyLandscapeGuard({ children, onExit }) {
  const [blocked, setBlocked] = useState(() => shouldBlockRummyPortrait());
  const rotateButtonRef = useRef(null);
  const ownsOrientationLockRef = useRef(false);
  const ownsFullscreenRef = useRef(false);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    let active = true;
    const update = () => {
      if (active) setBlocked(shouldBlockRummyPortrait(window));
    };
    const viewport = window.visualViewport;
    const orientation = window.screen?.orientation;

    window.addEventListener("resize", update, { passive: true });
    window.addEventListener("orientationchange", update, { passive: true });
    viewport?.addEventListener?.("resize", update, { passive: true });
    orientation?.addEventListener?.("change", update, { passive: true });
    void requestRummyLandscape(window).then(({ locked }) => {
      if (active && locked) ownsOrientationLockRef.current = true;
    });

    return () => {
      active = false;
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", update);
      viewport?.removeEventListener?.("resize", update);
      orientation?.removeEventListener?.("change", update);
      if (ownsOrientationLockRef.current) {
        try { orientation?.unlock?.(); } catch { /* Browser owns the fallback. */ }
      }
      if (
        ownsFullscreenRef.current
        && window.document?.fullscreenElement === window.document?.documentElement
        && window.document?.exitFullscreen
      ) {
        try { void Promise.resolve(window.document.exitFullscreen()).catch(() => {}); } catch { /* Browser already exited. */ }
      }
    };
  }, []);

  useEffect(() => {
    if (blocked) rotateButtonRef.current?.focus?.({ preventScroll: true });
  }, [blocked]);

  const enterLandscape = useCallback(async () => {
    const { locked, enteredFullscreen } = await requestRummyLandscape(window, { allowFullscreen: true });
    if (locked) ownsOrientationLockRef.current = true;
    if (enteredFullscreen) ownsFullscreenRef.current = true;
    setBlocked(shouldBlockRummyPortrait(window));
  }, []);

  return (
    <>
      <div className="rummy-landscape-content" inert={blocked ? true : undefined} aria-hidden={blocked ? "true" : undefined}>
        {children}
      </div>
      {blocked && (
        <main className="rummy-orientation-gate" style={RUMMY_ART} data-testid="rummy-orientation-gate" role="dialog" aria-modal="true" aria-labelledby="rummy-orientation-title">
          <button type="button" className="rummy-orientation-back" onClick={onExit} aria-label="Leave Rummy"><ArrowLeft /></button>
          <section>
            <span className="rummy-orientation-eyebrow">CHAKRI.CASINO · RUMMY</span>
            <div className="rummy-orientation-phone" aria-hidden="true"><i /><b>♛</b></div>
            <h1 id="rummy-orientation-title">Rotate to landscape</h1>
            <p>Turn your phone sideways to reveal the full royal table, your cards and every play control along the bottom.</p>
            <button ref={rotateButtonRef} type="button" className="rummy-orientation-enter" onClick={enterLandscape}><RotateCcw /> ENTER LANDSCAPE</button>
            <small>If your browser cannot rotate automatically, turn the device by hand.</small>
          </section>
        </main>
      )}
    </>
  );
}

export function visibleRummyName(value, automated = false, fallback = "Player") {
  const raw = String(value || "").trim();
  if (!automated) return raw || fallback;
  const cleaned = raw
    .replace(/\s*(?:[|:·—–-]\s*)?\b(?:bots?|auto)\b(?:\s*[|:·—–-]\s*[a-z0-9 ]+)?\s*$/i, "")
    .trim();
  return cleaned || fallback;
}

export function rummyAvatarKeyForSeat(seat) {
  const configured = String(seat?.avatarKey || seat?.avatar || "").trim().toLowerCase();
  const configuredMatch = /^avatar-(\d{1,2})$/.exec(configured);
  const configuredNumber = Number(configuredMatch?.[1]);
  if (Number.isInteger(configuredNumber) && configuredNumber >= 1 && configuredNumber <= 60) {
    return `avatar-${String(configuredNumber).padStart(2, "0")}`;
  }
  const seatIndex = Number.isFinite(Number(seat?.seatIndex)) ? Math.abs(Math.trunc(Number(seat.seatIndex))) : 0;
  return `avatar-${String((seatIndex % 60) + 1).padStart(2, "0")}`;
}

const RUMMY_REACTIONS = Object.freeze([
  { id: "wow", glyph: "♛", label: "Royal move", message: "Royal move!", eventType: "EMOJI" },
  { id: "clap", glyph: "👏", label: "Well played", message: "Well played!", eventType: "EMOJI" },
  { id: "thinking", glyph: "🤔", label: "Thinking", message: "Let me think…" },
  { id: "good-game", glyph: "🤝", label: "Good game", message: "Good game, everyone!", eventType: "EMOJI" },
  { id: "smile", glyph: "😊", label: "Smile", message: "Good luck!", eventType: "EMOJI" },
  { id: "laugh", glyph: "😄", label: "Laugh", message: "That was close!" },
  { id: "royal-clap", glyph: "♛", label: "Royal clap", message: "A royal applause!", eventType: "GIF", animated: true },
  { id: "crown-bounce", glyph: "♕", label: "Crown bounce", message: "Crown-worthy play!", eventType: "GIF", animated: true },
  { id: "card-dance", glyph: "🂡", label: "Card dance", message: "The cards are dancing!", eventType: "GIF", animated: true },
  { id: "victory-spark", glyph: "✦", label: "Victory spark", message: "What a finish!", eventType: "GIF", animated: true },
]);

const RUMMY_AMBIENT_PRESETS = Object.freeze([
  { id: "palace-hush", name: "Palace hush", detail: "Soft tanpura-inspired harmony", volume: .055 },
  { id: "royal-focus", name: "Royal focus", detail: "Warm ceremonial chord bed", volume: .075 },
  { id: "grand-hall", name: "Grand hall", detail: "Full palace music atmosphere", volume: .095 },
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

export function getRummyScheduleInfo(source, now = Date.now()) {
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
  const seconds = scheduledAt == null
    ? Math.max(0, Math.ceil(Number(directSeconds)))
    : Math.max(0, Math.ceil((scheduledAt - now) / 1000));
  return {
    seconds,
    scheduledAt,
    cycleSeconds: Math.max(1, Number(timing.cycleSeconds || timing.tableCycleSeconds || RUMMY_TABLE_CYCLE_SECONDS)),
    scheduleId: timing.cycleId || timing.scheduleId || timing.tableScheduleId || null,
  };
}

const formatRummyCountdown = (seconds) => {
  const safe = Math.max(0, Math.ceil(Number(seconds) || 0));
  return `${String(Math.floor(safe / 60)).padStart(2, "0")}:${String(safe % 60).padStart(2, "0")}`;
};

function useRummySchedule(source) {
  const [now, setNow] = useState(() => Date.now());
  const schedule = getRummyScheduleInfo(source, now);
  useEffect(() => {
    if (!getRummyScheduleInfo(source, Date.now())) return undefined;
    let active = true;
    let timer = null;
    const tick = () => {
      if (!active) return;
      setNow(Date.now());
      timer = window.setTimeout(tick, 1000);
    };
    timer = window.setTimeout(tick, 1000);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [source]);
  return schedule;
}

function NextTableSchedule({ source, compact = false }) {
  const schedule = useRummySchedule(source);
  if (!schedule) return null;
  const startLabel = schedule.scheduledAt == null
    ? "Server-scheduled start"
    : new Date(schedule.scheduledAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return (
    <div className={`rummy-next-table ${compact ? "is-compact" : ""}`} data-testid="rummy-next-table-countdown" role="timer" aria-live="off">
      <span>NEXT TABLE</span>
      <strong>{formatRummyCountdown(schedule.seconds)}</strong>
      <small>{startLabel} · {Math.round(schedule.cycleSeconds / 60)} min cycle</small>
    </div>
  );
}

const normalizeTableMessages = (state) => {
  const rows = state?.chatEvents || state?.chatMessages || state?.tableChatMessages || state?.chat?.messages || [];
  if (!Array.isArray(rows)) return [];
  return rows.slice(-30).map((row, index) => {
    const automated = Boolean(row.sender?.isBot || row.isBot || row.senderType === "BOT");
    return {
      id: row.id || row.messageId || `${row.createdAt || "message"}-${index}`,
      senderName: visibleRummyName(row.sender?.displayName || row.sender?.name || row.senderName || row.displayName || row.playerName, automated),
      seatIndex: row.sender?.seatIndex ?? row.seatIndex ?? null,
      isBot: automated,
      message: String(row.message || row.text || row.reactionText || "")
        .replace(/^\s*(?:auto|bot)\s+atmosphere\s+suggestion\s*:\s*/i, ""),
      glyph: row.glyph || row.emoji || RUMMY_REACTIONS.find((reaction) => reaction.id === row.reactionId)?.glyph || "",
      createdAt: row.createdAt || row.timestamp || null,
    };
  }).filter((row) => row.message || row.glyph);
};

function RoyalGlyph({ name }) {
  const paths = {
    chat: <><path d="M5 6.5h14v9H11l-4.5 3v-3H5z" /><path d="M8.5 10h7M8.5 12.5h4.5" /></>,
    music: <><path d="M9 17V7.5l8-2V15" /><circle cx="6.8" cy="17.3" r="2.3" /><circle cx="14.8" cy="15.3" r="2.3" /></>,
    help: <><circle cx="12" cy="12" r="8" /><path d="M9.8 9.5a2.4 2.4 0 0 1 4.6.9c0 1.9-2.4 2.1-2.4 3.6M12 17h.01" /></>,
    send: <><path d="m4 5 16 7-16 7 2-7z" /><path d="M6 12h8" /></>,
  };
  return <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">{paths[name]}</svg>;
}

function SocialDrawer({
  open,
  onClose,
  messages,
  onReaction,
  onSupportRequest,
  busy,
  musicOn,
  musicStatus,
  musicPreset,
  onMusicPreset,
  onToggleMusic,
  reducedMotion,
}) {
  const [tab, setTab] = useState("table");
  const [supportText, setSupportText] = useState("");
  const [supportStatus, setSupportStatus] = useState("");
  const panelRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose, open]);

  const submitSupport = async (kind) => {
    const request = supportText.trim();
    if (!request) {
      setSupportStatus(kind === "MUSIC_REQUEST" ? "Type the song or mood you would like." : "Type a message for Help Desk.");
      return;
    }
    setSupportStatus("Sending securely…");
    try {
      const response = await onSupportRequest(kind, request);
      const accepted = response === true || response?.accepted === true;
      const requestStatus = String(
        response?.requestStatus || (accepted ? "ACCEPTED" : "NOT_SENT"),
      ).replaceAll("_", " ").toLowerCase();
      if (accepted) {
        setSupportText("");
        setSupportStatus(`Request ${requestStatus}. Chakri Team replies will appear in your Support inbox.`);
      } else {
        setSupportStatus(response?.message || `Request ${requestStatus}. Please retry or open Support from your profile.`);
      }
    } catch (error) {
      setSupportStatus(error?.message ? `Request failed: ${error.message}` : "Request failed. Please retry or open Support from your profile.");
    }
  };

  if (!open) return null;
  return (
    <motion.aside
      ref={panelRef}
      className="rummy-social-drawer"
      aria-label="Rummy table chat and music"
      initial={reducedMotion ? false : { opacity: 0, x: 28, scale: .98 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      transition={{ duration: reducedMotion ? 0 : .34, ease: [.16, 1, .3, 1] }}
    >
      <header><div><span>ROYAL TABLE</span><b>Conversation</b></div><button type="button" onClick={onClose} aria-label="Close table conversation"><X /></button></header>
      <nav aria-label="Conversation sections">
        <button type="button" className={tab === "table" ? "is-active" : ""} aria-pressed={tab === "table"} onClick={() => setTab("table")}><RoyalGlyph name="chat" />Table</button>
        <button type="button" className={tab === "music" ? "is-active" : ""} aria-pressed={tab === "music"} onClick={() => setTab("music")}><RoyalGlyph name="music" />Music</button>
        <button type="button" className={tab === "help" ? "is-active" : ""} aria-pressed={tab === "help"} onClick={() => setTab("help")}><RoyalGlyph name="help" />Help Desk</button>
      </nav>

      {tab === "table" && <div className="rummy-chat-pane">
        <div className="rummy-chat-log" role="log" aria-live="polite" aria-label="Table messages">
          {messages.length ? messages.map((message) => (
            <article key={message.id} className={message.isBot ? "is-bot" : ""}>
              <div><b>{message.senderName}</b></div>
              <p>{message.glyph && <i aria-hidden>{message.glyph}</i>}{message.message}</p>
            </article>
          )) : <div className="rummy-chat-empty"><span>♛</span><b>The table is quiet</b><small>Use a friendly reaction to break the ice.</small></div>}
        </div>
        <div className="rummy-reaction-grid" aria-label="Quick table reactions">
          {RUMMY_REACTIONS.map((reaction) => <button key={reaction.id} type="button" className={reaction.animated ? "is-gif-reaction" : ""} disabled={busy} onClick={() => onReaction(reaction)} aria-label={`${reaction.label}${reaction.animated ? " animated reaction" : ""}`}><span aria-hidden>{reaction.glyph}</span><small>{reaction.label}{reaction.animated && <i>GIF</i>}</small></button>)}
        </div>
        <p className="rummy-chat-safety">Quick reactions are limited to the friendly options above.</p>
      </div>}

      {tab === "music" && <div className="rummy-music-pane">
        <div className="rummy-ambient-orb" data-playing={musicOn ? "true" : "false"} aria-hidden><span /><i /><b>♪</b></div>
        <span>ORIGINAL WEB AUDIO · NO RECORDED TRACK</span>
        <h3>Royal room ambience</h3>
        <p>Generated softly on your device. It is off until you choose to play it.</p>
        <div className="rummy-music-presets" role="radiogroup" aria-label="Ambience style">
          {RUMMY_AMBIENT_PRESETS.map((preset) => <button key={preset.id} type="button" role="radio" aria-checked={musicPreset === preset.id} className={musicPreset === preset.id ? "is-active" : ""} onClick={() => onMusicPreset(preset.id)}><b>{preset.name}</b><small>{preset.detail}</small></button>)}
        </div>
        <button type="button" className="rummy-music-toggle" aria-pressed={musicOn} onClick={onToggleMusic}><RoyalGlyph name="music" />{musicOn ? "STOP AMBIENCE" : "PLAY AMBIENCE"}</button>
        <small className="rummy-support-status rummy-music-status" role="status">{musicStatus}</small>
        <div className="rummy-request-divider"><span>OR ASK CHAKRI TEAM</span></div>
        <textarea value={supportText} maxLength={120} onChange={(event) => { setSupportText(event.target.value); setSupportStatus(""); }} placeholder="Type a motivational song or mood request…" aria-label="Music request" />
        <button type="button" className="rummy-request-submit" disabled={busy || !supportText.trim()} onClick={() => submitSupport("MUSIC_REQUEST")}><RoyalGlyph name="send" />SEND MUSIC REQUEST</button>
        <small className="rummy-support-status" role="status">{supportStatus || "Requests go to Help Desk; they do not change the table instantly."}</small>
      </div>}

      {tab === "help" && <div className="rummy-help-pane">
        <div className="rummy-help-crown" aria-hidden>♛</div>
        <span>CHAKRI TEAM</span>
        <h3>Help without leaving the table</h3>
        <p>Describe what you need. Submitting creates a support message; it does not promise an instant live response.</p>
        <textarea value={supportText} maxLength={240} onChange={(event) => { setSupportText(event.target.value); setSupportStatus(""); }} placeholder="Type your question for Help Desk…" aria-label="Help Desk message" />
        <button type="button" className="rummy-request-submit" disabled={busy || !supportText.trim()} onClick={() => submitSupport("HELP_DESK")}><RoyalGlyph name="send" />SUBMIT TO HELP DESK</button>
        <small className="rummy-support-status" role="status">{supportStatus || "You can read the reply later in Support & messages."}</small>
      </div>}
    </motion.aside>
  );
}

const settleAudio = (operation) => {
  try {
    return Promise.resolve(operation?.()).catch(() => false);
  } catch (_error) {
    return Promise.resolve(false);
  }
};

const focusWithoutScroll = (element) => {
  if (!element || typeof element.focus !== "function") return;
  try { element.focus({ preventScroll: true }); } catch (_error) { element.focus(); }
};

function useModalFocusTrap(active, dialogRef, onDismiss) {
  const dismissRef = useRef(onDismiss);
  useEffect(() => { dismissRef.current = onDismiss; }, [onDismiss]);
  useEffect(() => {
    if (!active || typeof document === "undefined") return undefined;
    const previousFocus = document.activeElement;
    const focusable = () => [...(dialogRef.current?.querySelectorAll(MODAL_FOCUSABLE) || [])]
      .filter((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true");
    focusWithoutScroll(focusable()[0] || dialogRef.current);
    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        dismissRef.current?.();
        return;
      }
      if (event.key !== "Tab") return;
      const candidates = focusable();
      if (!candidates.length) {
        event.preventDefault();
        focusWithoutScroll(dialogRef.current);
        return;
      }
      const currentIndex = candidates.indexOf(document.activeElement);
      const leavingBackwards = event.shiftKey && currentIndex <= 0;
      const leavingForwards = !event.shiftKey && (currentIndex < 0 || currentIndex === candidates.length - 1);
      if (!leavingBackwards && !leavingForwards) return;
      event.preventDefault();
      focusWithoutScroll(event.shiftKey ? candidates[candidates.length - 1] : candidates[0]);
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      const fallback = previousFocus?.isConnected && previousFocus !== document.body
        ? previousFocus
        : document.querySelector('[data-testid="rummy-category-lobby"] button:not([disabled]), [data-testid="rummy-live-table"] button:not([disabled])');
      focusWithoutScroll(fallback);
    };
  }, [active, dialogRef]);
}

export function nextRummyPollDelay(previousDelay, succeeded) {
  if (succeeded) return RUMMY_POLL_MS;
  return Math.min(RUMMY_POLL_MAX_MS, Math.max(RUMMY_POLL_MS, Number(previousDelay) || RUMMY_POLL_MS) * 2);
}

function useSoundState() {
  const [muted, setMuted] = useState(isMuted());
  useEffect(() => onMuteChange(setMuted), []);
  return muted;
}

export function RummyCard({ card, selected, raised, entering = false, motionId = null, onSelect, onDragStart, compact = false, reducedMotion = false, wildRank = null }) {
  if (!card) {
    return (
      <span className={`rummy-card rummy-card-placeholder ${compact ? "is-compact" : ""}`} aria-label="Card not dealt yet">
        <b>?</b>
      </span>
    );
  }
  const joker = card?.printedJoker || card?.code === "PJ";
  const wild = joker || (wildRank != null && Number(card?.rank) === Number(wildRank));
  const suit = SUITS[card?.suit];
  const rank = joker ? "J" : String(card?.code || "").slice(0, -1);
  const Root = onSelect ? motion.button : motion.div;
  const restingLift = raised ? -16 : selected ? -12 : 0;
  const pressedLift = raised || selected ? -14 : -9;
  const handMotion = onSelect && !reducedMotion ? {
    layout: "position",
    layoutId: motionId || undefined,
    initial: entering
      ? { opacity: 0, transform: "translate3d(0,-28px,0) scale(.96) rotate(2deg)" }
      : false,
    animate: { opacity: 1, transform: `translate3d(0,${restingLift}px,0) scale(1) rotate(0deg)` },
    whileTap: { transform: `translate3d(0,${pressedLift}px,0) scale(.975) rotate(0deg)` },
    exit: { opacity: 0, transform: "translate3d(0,-30px,0) scale(.96) rotate(3deg)" },
    transition: {
      layout: { type: "spring", duration: 0.24, bounce: 0.12 },
      opacity: { duration: 0.16, ease: [0.23, 1, 0.32, 1] },
      transform: { duration: 0.22, ease: [0.23, 1, 0.32, 1] },
    },
  } : {};
  return (
    <Root
      {...(onSelect ? { type: "button" } : {})}
      {...handMotion}
      draggable={Boolean(onDragStart)}
      onDragStart={(event) => onDragStart?.(event, card.id)}
      onClick={() => onSelect?.(card.id)}
      className={`rummy-card ${selected ? "is-selected" : ""} ${raised ? "is-raised" : ""} ${compact ? "is-compact" : ""} ${wild ? "is-wild-card" : ""}`}
      aria-pressed={selected}
      aria-label={joker ? "Printed joker" : `${rank} of ${card.suit}${wild ? ", wild joker" : ""}`}
      data-card-id={card.id}
      data-wild={wild ? "true" : "false"}
    >
      {joker ? (
        <><b className="rummy-joker-letter">J</b><span className="rummy-jester">♛</span><small>JOKER</small></>
      ) : (
        <>
          {wild && <span className="rummy-wild-crown" aria-hidden="true">♛</span>}
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

export function PlayerSeat({ seat, timer, turnDuration = 30, reducedMotion, viewerSeatIndex }) {
  const active = seat?.active;
  const occupied = seat?.status !== "EMPTY";
  const timerText = active && timer != null ? Math.max(0, Math.ceil(timer)) : null;
  const turnProgress = timerText == null
    ? 0
    : Math.max(0.02, Math.min(1, Number(timer || 0) / Math.max(1, Number(turnDuration) || 30)));
  const turnTone = turnProgress > 0.5 ? "emerald" : turnProgress > 0.2 ? "amber" : "ruby";
  const avatarKey = rummyAvatarKeyForSeat(seat);
  const avatarUrl = seat?.avatarUrl || seat?.avatar_url || seat?.profileAvatarUrl || null;
  const seatName = visibleRummyName(seat?.displayName, seat?.isBot, "Rummy player");
  return (
    <div className={`rummy-seat rummy-seat-${seat.seatIndex} ${active ? "is-active" : ""} is-${String(seat.status || "empty").toLowerCase()}`}>
      <div
        className={`rummy-avatar-ring ${timerText == null ? "" : `is-counting is-${turnTone}`}`.trim()}
        style={timerText == null ? undefined : { "--turn-progress": turnProgress }}
      >
        {occupied ? (
          <ProfileAvatar
            avatarKey={avatarKey}
            avatarUrl={avatarUrl}
            size="100%"
            alt={`${seatName} portrait`}
            className="rummy-seat-avatar"
            testId={`rummy-seat-avatar-${seat.seatIndex}`}
            loading="eager"
          />
        ) : <span className="rummy-empty-avatar" aria-hidden>+</span>}
        {timerText != null && <b className="rummy-only-timer" role="timer" aria-live="off" aria-label={`${timerText} seconds remaining`}>{timerText}</b>}
      </div>
      <strong>{seat.status === "EMPTY" ? "Waiting" : seatName}</strong>
      <small>{seat.status === "DROPPED" ? `Dropped · ${seat.droppedPoints ?? seat.points ?? 0} pts` : seat.isBot ? "PLAYING" : seat.playerId}</small>
      {seat.latestReaction && <span className="rummy-seat-reaction" aria-label={`${seatName} reacted ${seat.latestReaction.message || seat.latestReaction.emoji || ""}`}><i aria-hidden>{seat.latestReaction.emoji || seat.latestReaction.glyph || "♛"}</i>{seat.latestReaction.message || ""}</span>}
      {seat.cardCount > 0 && seat.seatIndex !== viewerSeatIndex && <CardBack count={seat.cardCount} />}
      {active && !reducedMotion && <span className="rummy-active-flare" aria-hidden />}
    </div>
  );
}

export function rummyTurnAnnouncement(activeSeat, viewerSeatIndex, timer, turnDuration = 30) {
  if (!activeSeat || timer == null) return "";
  const remaining = Math.max(0, Number(timer) || 0);
  const duration = Math.max(1, Number(turnDuration) || 30);
  const progress = remaining / duration;
  const ownTurn = Number(activeSeat.seatIndex) === Number(viewerSeatIndex);
  const playerName = visibleRummyName(activeSeat.displayName, activeSeat.isBot, "Player");
  if (progress <= 0.2) return ownTurn ? "Final seconds for your turn." : `Final seconds for ${playerName}.`;
  if (progress <= 0.5) return ownTurn ? "Less than half of your turn remains." : `Less than half of ${playerName}'s turn remains.`;
  return ownTurn ? "Your turn started." : `${playerName}'s turn started.`;
}

function Deck({ label, card, count, disabled, onClick, open = false, reducedMotion = false }) {
  return (
    <button type="button" className={`rummy-deck ${open ? "is-open" : ""}`} disabled={disabled} onClick={onClick} aria-label={label}>
      {open && card ? <RummyCard card={card} compact reducedMotion={reducedMotion} /> : <CardBack count={count} />}
      <b>{label}</b>
    </button>
  );
}

export function RummyTable({ state, busy, reconnecting, sendAction, sendSocialEvent = async () => null, onSupportRequest = async () => false, onExit, audioController }) {
  const reducedMotion = useReducedMotion();
  const muted = useSoundState();
  const [tableArtReady, setTableArtReady] = useState(false);
  const [selected, setSelected] = useState([]);
  const [groups, setGroups] = useState([]);
  const [groupLabels, setGroupLabels] = useState([]);
  const [dropOpen, setDropOpen] = useState(false);
  const [socialOpen, setSocialOpen] = useState(false);
  const [localChatMessages, setLocalChatMessages] = useState([]);
  const [musicOn, setMusicOn] = useState(false);
  const [musicStatus, setMusicStatus] = useState("Ambience is off.");
  const [musicPreset, setMusicPreset] = useState(RUMMY_AMBIENT_PRESETS[0].id);
  const [arrivingCardId, setArrivingCardId] = useState(null);
  const [atmosphereEvent, setAtmosphereEvent] = useState({ phase: RUMMY_ATMOSPHERE_PHASES.TABLE, id: 0 });
  const dropDialogRef = useRef(null);
  const lastRoundRef = useRef(null);
  const lastResultRef = useRef(null);
  const viewerSeatIndexRef = useRef(null);
  const authoritativeGroupsRef = useRef("");
  const previousCardIdsRef = useRef(new Set());
  const privateState = state.privateState;
  const seats = Array.from({ length: 5 }, (_, seatIndex) => (
    state.seats?.find((seat) => seat?.seatIndex === seatIndex)
    || { seatIndex, status: "EMPTY", cardCount: 0, displayName: "" }
  ));
  const privateSeatIndex = Number(privateState?.seatIndex);
  const viewerSeatIndex = Number.isInteger(privateSeatIndex) ? privateSeatIndex : viewerSeatIndexRef.current;
  const cards = useMemo(() => privateState?.cards || [], [privateState?.cards]);
  const cardIds = useMemo(() => new Set(cards.map((card) => card.id)), [cards]);
  const authoritativeGroups = useMemo(() => privateState?.groups || [], [privateState?.groups]);
  const authoritativeSignature = groupSignature(authoritativeGroups);
  const authoritativeLabels = useMemo(
    () => privateState?.groupLabels || privateState?.groupValidation?.groups || [],
    [privateState?.groupLabels, privateState?.groupValidation?.groups],
  );
  const serverChatMessages = useMemo(() => normalizeTableMessages(state), [state]);
  const chatMessages = useMemo(() => {
    const merged = new Map();
    [...serverChatMessages, ...localChatMessages].forEach((message) => merged.set(message.id, message));
    return [...merged.values()].slice(-30);
  }, [localChatMessages, serverChatMessages]);
  const selectedAmbient = RUMMY_AMBIENT_PRESETS.find((preset) => preset.id === musicPreset) || RUMMY_AMBIENT_PRESETS[0];

  useEffect(() => {
    if (Number.isInteger(privateSeatIndex)) viewerSeatIndexRef.current = privateSeatIndex;
  }, [privateSeatIndex]);

  const dropModalOpen = dropOpen && !state.result;
  const closeDrop = useCallback(() => setDropOpen(false), []);
  useModalFocusTrap(dropModalOpen, dropDialogRef, closeDrop);
  useEffect(() => {
    if (state.result) setDropOpen(false);
  }, [state.result]);
  useEffect(() => {
    setLocalChatMessages([]);
    setSocialOpen(false);
  }, [state.roomId]);
  useEffect(() => {
    audioController?.setAmbientVolume?.(selectedAmbient.volume);
    audioController?.setAmbientPreset?.(selectedAmbient.id);
  }, [audioController, selectedAmbient.id, selectedAmbient.volume]);
  useEffect(() => () => {
    audioController?.stopAmbient?.();
  }, [audioController]);
  useEffect(() => {
    if (muted) {
      setMusicOn(false);
      setMusicStatus("Table sound is muted. Turn sound on to play ambience.");
      audioController?.stopAmbient?.();
      return;
    }
    setMusicStatus((current) => current.startsWith("Table sound is muted") ? "Ambience is off." : current);
  }, [audioController, muted]);

  useEffect(() => {
    const roundChanged = lastRoundRef.current !== state.roundId;
    const groupsChanged = authoritativeGroupsRef.current !== authoritativeSignature;
    if (roundChanged || groupsChanged) {
      lastRoundRef.current = state.roundId;
      authoritativeGroupsRef.current = authoritativeSignature;
      setGroups(authoritativeGroups);
      setGroupLabels(authoritativeLabels);
      setSelected([]);
    } else {
      setGroups((current) => current.map((group) => group.filter((id) => cardIds.has(id))).filter((group) => group.length));
      setSelected((current) => current.filter((id) => cardIds.has(id)));
    }
  }, [authoritativeGroups, authoritativeLabels, authoritativeSignature, cardIds, state.roundId]);

  useEffect(() => {
    const previous = previousCardIdsRef.current;
    const addedCard = cards.find((card) => !previous.has(card.id));
    previousCardIdsRef.current = new Set(cards.map((card) => card.id));
    if (!addedCard || addedCard.id !== privateState?.drawnCardId) return undefined;
    setArrivingCardId(addedCard.id);
    const timer = window.setTimeout(() => setArrivingCardId((current) => current === addedCard.id ? null : current), 260);
    return () => window.clearTimeout(timer);
  }, [cards, privateState?.drawnCardId]);

  const cardMap = useMemo(() => Object.fromEntries(cards.map((card) => [card.id, card])), [cards]);
  const groupedIds = useMemo(() => new Set(groups.flat()), [groups]);
  const ungrouped = cards.filter((card) => !groupedIds.has(card.id));
  const mySeat = seats.find((seat) => seat.playerId && !seat.isBot && seat.seatIndex === viewerSeatIndex) || seats[0];

  const toggleCard = (cardId) => setSelected((current) => current.includes(cardId) ? current.filter((id) => id !== cardId) : [...current, cardId]);
  const triggerAtmosphere = useCallback((phase) => {
    setAtmosphereEvent((current) => ({ phase, id: current.id + 1 }));
  }, []);
  const playAudioCue = useCallback((cue) => {
    void settleAudio(() => audioController?.play?.(cue));
  }, [audioController]);
  const unlockTableAudio = useCallback(() => {
    void settleAudio(() => audioController?.enableFromGesture?.());
  }, [audioController]);
  const toggleMusic = useCallback(async () => {
    if (musicOn) {
      audioController?.stopAmbient?.();
      setMusicOn(false);
      setMusicStatus("Ambience stopped.");
      return;
    }
    if (muted) {
      setMusicStatus("Table sound is muted. Turn sound on to play ambience.");
      toast.info("Turn table sound on before playing ambience");
      return;
    }
    setMusicStatus("Starting generated ambience…");
    audioController?.setAmbientVolume?.(selectedAmbient.volume);
    audioController?.setAmbientPreset?.(selectedAmbient.id);
    const ready = await settleAudio(() => audioController?.enableFromGesture?.());
    const started = ready && await settleAudio(() => audioController?.startAmbient?.());
    if (!started) {
      setMusicStatus("Ambience could not start. Check device audio permissions and try again.");
      toast.info("Audio is unavailable on this device");
      return;
    }
    setMusicOn(true);
    setMusicStatus("Generated royal ambience is playing.");
  }, [audioController, musicOn, muted, selectedAmbient.id, selectedAmbient.volume]);
  const sendReaction = useCallback(async (reaction) => {
    const response = await sendSocialEvent({
      eventType: reaction.eventType || "EMOJI",
      reactionId: reaction.id,
    });
    if (!response?.accepted) return false;
    const normalized = normalizeTableMessages({ chatEvents: response.event ? [response.event] : [] });
    const message = normalized[0] || {
      id: response.requestId || `local-${Date.now()}`,
      senderName: "You",
      isBot: false,
      message: reaction.message,
      glyph: reaction.glyph,
    };
    setLocalChatMessages((current) => [...current, message].slice(-12));
    return true;
  }, [sendSocialEvent]);
  const performAction = async (actionType, actionPayload = {}) => {
    const acknowledged = await sendAction(actionType, actionPayload);
    if (!acknowledged) return null;
    if (actionType.startsWith("DRAW")) {
      triggerAtmosphere(RUMMY_ATMOSPHERE_PHASES.DRAW);
      playAudioCue(RUMMY_AUDIO_CUES.DRAW);
    } else if (actionType === "DISCARD" || actionType === "DISCARD_AND_DECLARE") {
      triggerAtmosphere(RUMMY_ATMOSPHERE_PHASES.DISCARD);
      playAudioCue(RUMMY_AUDIO_CUES.DISCARD);
    } else if (["GROUP", "UNGROUP", "SORT"].includes(actionType)) {
      playAudioCue(RUMMY_AUDIO_CUES.CARD_SLIDE);
    } else if (actionType === "DROP") {
      triggerAtmosphere(RUMMY_ATMOSPHERE_PHASES.DROP);
      playAudioCue(RUMMY_AUDIO_CUES.DROP);
    }
    return acknowledged;
  };
  const labelsFor = (nextGroups, fallback = []) => nextGroups.map((group, index) => {
    const exactIndex = groups.findIndex((existing) => groupSignature([existing]) === groupSignature([group]));
    return exactIndex >= 0 ? groupLabels[exactIndex] : fallback[index] || "UNVALIDATED";
  });
  const persistGroups = async (next, optimisticLabels = []) => {
    const previousGroups = groups;
    const previousLabels = groupLabels;
    setGroups(next);
    setGroupLabels(labelsFor(next, optimisticLabels));
    setSelected([]);
    const acknowledged = await performAction("GROUP", { groups: next });
    if (!acknowledged) {
      setGroups(previousGroups);
      setGroupLabels(previousLabels);
      return false;
    }
    const exact = acknowledged.privateState;
    const confirmedGroups = exact?.groups || next;
    authoritativeGroupsRef.current = groupSignature(confirmedGroups);
    setGroups(confirmedGroups);
    setGroupLabels(exact?.groupLabels || exact?.groupValidation?.groups || optimisticLabels);
    return true;
  };
  const autoSort = async () => {
    const suggestedRows = privateState?.suggestedGroups || [];
    const suggested = suggestedRows.map((row) => row.cardIds);
    await persistGroups(suggested, suggestedRows.map((row) => row.label));
  };
  const groupSelected = async () => {
    if (selected.length < 2) return toast.info("Select at least two cards to make a group");
    const next = [...groups.map((group) => group.filter((id) => !selected.includes(id))).filter((group) => group.length), selected];
    await persistGroups(next);
  };
  const ungroupSelected = async () => {
    if (!selected.length) return;
    const next = groups.map((group) => group.filter((id) => !selected.includes(id))).filter((group) => group.length);
    await persistGroups(next);
  };
  const dropInto = async (groupIndex, cardId) => {
    const next = groups.map((group) => group.filter((id) => id !== cardId));
    if (!next[groupIndex]) next[groupIndex] = [];
    next[groupIndex].push(cardId);
    await persistGroups(next.filter((group) => group.length));
  };
  const discard = async () => {
    if (selected.length !== 1) return toast.info("Select exactly one card to discard");
    await performAction("DISCARD", { cardId: selected[0] });
    setSelected([]);
  };
  const declarableDiscardIds = privateState?.declarableDiscardCardIds || [];
  const selectedDeclarableDiscard = selected.length === 1 && declarableDiscardIds.includes(selected[0]) ? selected[0] : null;
  const canExactDeclare = Boolean(privateState?.canDeclare && privateState?.groupValidation?.valid);
  const declare = async () => {
    if (privateState?.drawn) {
      if (!selectedDeclarableDiscard) return toast.info("Select the highlighted unmatched card to discard and declare");
      const declarationGroups = groups
        .map((group) => group.filter((id) => id !== selectedDeclarableDiscard))
        .filter((group) => group.length);
      return performAction("DISCARD_AND_DECLARE", { cardId: selectedDeclarableDiscard, groups: declarationGroups });
    }
    if (!canExactDeclare) return toast.info("Complete the exact server-validated groups before declaring");
    return performAction("DECLARE", { groups });
  };

  const resultKey = state.result
    ? `${state.roundId || "round"}:${state.result.winnerSeat}:${state.result.reason || "result"}`
    : null;
  useEffect(() => {
    if (!resultKey || lastResultRef.current === resultKey) return;
    lastResultRef.current = resultKey;
    const reason = String(state.result?.reason || "").toUpperCase();
    if (state.result?.winnerSeat === viewerSeatIndex) {
      triggerAtmosphere(RUMMY_ATMOSPHERE_PHASES.VALID_DECLARE);
      playAudioCue(RUMMY_AUDIO_CUES.DECLARE);
    } else if (reason.includes("INVALID")) {
      triggerAtmosphere(RUMMY_ATMOSPHERE_PHASES.INVALID);
      playAudioCue(RUMMY_AUDIO_CUES.INVALID);
    } else if (!reason.includes("DROPPED")) {
      triggerAtmosphere(RUMMY_ATMOSPHERE_PHASES.INVALID);
      playAudioCue(RUMMY_AUDIO_CUES.INVALID);
    }
  }, [playAudioCue, resultKey, state.result, triggerAtmosphere, viewerSeatIndex]);

  const waitingCount = Math.max(0, Number(state.maxPlayers || 5) - seats.filter((seat) => seat.status !== "EMPTY").length);
  const activeSeat = seats.find((seat) => seat.seatIndex === state.currentSeat);
  const turnAnnouncement = rummyTurnAnnouncement(
    activeSeat,
    viewerSeatIndex,
    state.turnEndsIn,
    state.category?.turnDurationSeconds,
  );
  const opponentPhase = state.botAction?.phase === "DISCARDING" ? "choosing a discard" : "thinking";
  const status = state.state === "WAITING_FOR_PLAYERS"
    ? `Waiting for ${waitingCount} more player${waitingCount === 1 ? "" : "s"}`
    : state.state === "CANCELLED"
      ? "This table has closed"
      : state.result
        ? "Round complete"
        : state.currentSeat === mySeat?.seatIndex
          ? privateState?.drawn ? "Choose one card to discard" : "Your turn · draw from either pile"
          : activeSeat?.isBot
            ? `${visibleRummyName(activeSeat.displayName, true)} · ${opponentPhase}`
            : `${visibleRummyName(activeSeat?.displayName)}'s turn`;
  const validationCode = privateState?.groupValidation?.code;

  return (
    <main className="rummy-game" style={RUMMY_ART} data-testid="rummy-live-table" data-state={state.state} data-mode={state.mode} onPointerDownCapture={unlockTableAudio} onKeyDownCapture={unlockTableAudio}>
      <header className="rummy-game-head">
        <button type="button" onClick={onExit} aria-label="Leave Rummy"><ArrowLeft /></button>
        <div className={`rummy-live-pill ${state.walletNeutral ? "is-bot-table" : ""}`}><i />{
          state.mode === "BOT_TABLE" ? "PRACTICE TABLE · FREE" : state.mode === "PRACTICE" ? "PRACTICE MODE" : "LIVE MODE"
        }</div>
        <div className="rummy-balance"><Coins /><b>{formatChips(state.balance)}</b><span>chips</span></div>
        <div className="rummy-table-utilities">
          <button type="button" className={socialOpen ? "is-active" : ""} onClick={() => setSocialOpen((current) => !current)} aria-label={socialOpen ? "Close Rummy table conversation" : "Open Rummy table conversation"} aria-expanded={socialOpen}><RoyalGlyph name="chat" /><span>TABLE</span>{chatMessages.length > 0 && <i>{Math.min(9, chatMessages.length)}</i>}</button>
          <button type="button" onClick={toggleMuted} aria-label={muted ? "Turn Rummy sound on" : "Mute Rummy sound"}>{muted ? <VolumeX /> : <Volume2 />}</button>
        </div>
      </header>

      {state.state === "WAITING_FOR_PLAYERS" ? (
        <section className="rummy-special-state is-waiting" data-testid="rummy-waiting-room">
          <div className="rummy-matchmaking-orbit" aria-hidden><span /><span /><span /><span /><span /></div>
          <span>LIVE TABLE MATCHMAKING</span>
          <h1>{status}</h1>
          <p>Your {formatChips(state.category?.entryChips)}-chip seat is reserved. Leaving before the deal restores the exact reserved stake.</p>
          <NextTableSchedule source={state} />
          {state.fallbackStartsIn != null && (
            <p className="rummy-fallback-note" data-testid="rummy-fallback-countdown">
              Game starts in {Math.max(0, Math.ceil(state.fallbackStartsIn))}s.
            </p>
          )}
          <div className="rummy-waiting-seats" aria-label="Occupied Rummy seats">
            {seats.map((seat) => <PlayerSeat key={seat.seatIndex} seat={seat} timer={null} reducedMotion={reducedMotion} viewerSeatIndex={viewerSeatIndex} />)}
          </div>
          <button type="button" onClick={onExit} disabled={busy}>LEAVE TABLE &amp; RESTORE STAKE</button>
        </section>
      ) : state.state === "CANCELLED" ? (
        <section className="rummy-special-state is-cancelled" data-testid="rummy-cancelled-room" role="status">
          <ShieldCheck />
          <span>ROUND CLOSED SAFELY</span>
          <h1>No result was recorded</h1>
          <p>{state.cancelReason || "The table could not continue. Any reserved live stake is restored by the server exactly once."}</p>
          <button type="button" onClick={onExit}>RETURN TO RUMMY LOBBY</button>
        </section>
      ) : <section className="rummy-stage">
        <div className="rummy-status" aria-live="polite">{status}</div>
        <div className="rummy-sr-only" role="status" aria-live="polite" aria-atomic="true">{turnAnnouncement}</div>
        <div className={`rummy-table-slot ${tableArtReady ? "is-art-ready" : "is-art-loading"}`} data-table-art-ready={tableArtReady ? "true" : "false"}>
          <div className="rummy-table" aria-label="Five-seat Rummy table">
            <img
              className="rummy-table-art"
              src={RUMMY_PALACE_ART}
              alt=""
              aria-hidden="true"
              draggable="false"
              onLoad={(event) => {
                const image = event.currentTarget;
                const decoded = typeof image.decode === "function" ? image.decode() : Promise.resolve();
                Promise.resolve(decoded).catch(() => undefined).finally(() => setTableArtReady(true));
              }}
            />
            <RummyAtmosphere
              phase={atmosphereEvent.phase}
              eventId={atmosphereEvent.id}
              reducedMotion={reducedMotion}
              seed={`${state.roomId || "practice"}:${state.roundId || 0}`}
              className="rummy-atmosphere"
            />
            <div className="rummy-table-hud" aria-label="Current Rummy hand information">
              <div><span>TABLE</span><b>{state.category?.id || "—"}</b></div>
              <div><span>POINT VALUE</span><b>{formatChips(state.category?.pointsValue)} chips</b></div>
              <div><span>ENTRY</span><b>{formatChips(state.category?.entryChips)} chips</b></div>
              <div><span>HAND POINTS</span><b>{privateState?.points ?? "—"}</b></div>
              <div className="is-drop"><span>DROP NOW</span><b>{privateState?.dropPenaltyPoints == null ? "—" : `${privateState.dropPenaltyPoints} pts`}</b></div>
            </div>
            {seats.map((seat) => <PlayerSeat key={seat.seatIndex} seat={seat} timer={seat.active ? state.turnEndsIn : null} turnDuration={state.category?.turnDurationSeconds} reducedMotion={reducedMotion} viewerSeatIndex={viewerSeatIndex} />)}
            <div className="rummy-piles">
              {state.currentSeat === mySeat?.seatIndex && privateState?.canDraw && (
                <div className="rummy-local-hint is-draw" role="status">Draw from either pile</div>
              )}
              <Deck label="CLOSED DECK" count={state.closedDeckCount} disabled={busy || !privateState?.canDraw} onClick={() => performAction("DRAW_CLOSED")} reducedMotion={reducedMotion} />
              <Deck label="OPEN CARD" card={state.openDiscard} open disabled={busy || !privateState?.canDraw || !state.openDiscard} onClick={() => performAction("DRAW_DISCARD")} reducedMotion={reducedMotion} />
              <div className="rummy-wild"><RummyCard card={state.wildJoker} compact reducedMotion={reducedMotion} /><span>WILD JOKER</span></div>
            </div>
          </div>
        </div>

        {privateState && (
          <section className="rummy-hand-zone" aria-label="Your thirteen-card hand" data-card-count={cards.length}>
            <LayoutGroup id={`rummy-hand-${state.roomId || state.roundId || "table"}`}>
              <div className="rummy-group-rail" tabIndex="0" aria-label={`${cards.length} cards arranged in ${groups.length + (ungrouped.length ? 1 : 0)} groups`}>
                {groups.map((group, index) => (
                  <motion.div
                    layout={!reducedMotion}
                    transition={{ layout: { type: "spring", duration: 0.24, bounce: 0.1 } }}
                    key={`group-${index}`}
                    className="rummy-group"
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={(event) => { event.preventDefault(); const id = event.dataTransfer.getData("text/rummy-card"); if (id) dropInto(index, id); }}
                  >
                    <div>
                      <AnimatePresence initial={false} mode="popLayout">
                        {group.map((id) => cardMap[id] && <RummyCard key={id} motionId={`rummy-hand-card-${id}`} entering={arrivingCardId === id} card={cardMap[id]} selected={selected.includes(id)} raised={privateState.drawnCardId === id} onSelect={toggleCard} onDragStart={(event, cardId) => event.dataTransfer.setData("text/rummy-card", cardId)} reducedMotion={reducedMotion} wildRank={state.wildJoker?.rank} />)}
                      </AnimatePresence>
                    </div>
                    <span className={`rummy-group-label is-${String(groupLabels[index] || "unvalidated").toLowerCase()}`}>{readableRuleLabel(groupLabels[index], `GROUP ${index + 1}`)}</span>
                  </motion.div>
                ))}
                {ungrouped.length > 0 && (
                  <motion.div layout={!reducedMotion} transition={{ layout: { type: "spring", duration: 0.24, bounce: 0.1 } }} className="rummy-group is-ungrouped">
                    <div>
                      <AnimatePresence initial={false} mode="popLayout">
                        {ungrouped.map((card) => <RummyCard key={card.id} motionId={`rummy-hand-card-${card.id}`} entering={arrivingCardId === card.id} card={card} selected={selected.includes(card.id)} raised={privateState.drawnCardId === card.id} onSelect={toggleCard} onDragStart={(event, cardId) => event.dataTransfer.setData("text/rummy-card", cardId)} reducedMotion={reducedMotion} wildRank={state.wildJoker?.rank} />)}
                      </AnimatePresence>
                    </div>
                    <span className="rummy-group-label is-invalid">UNGROUPED</span>
                  </motion.div>
                )}
              </div>
            </LayoutGroup>
            <div className="rummy-actions">
              <button type="button" onClick={autoSort} disabled={busy}><RotateCcw />SORT HAND</button>
              <button type="button" onClick={groupSelected} disabled={busy || selected.length < 2}><Layers3 />GROUP</button>
              <button type="button" onClick={ungroupSelected} disabled={busy || !selected.length}><X />UNGROUP</button>
              <button type="button" className="is-drop" onClick={() => { playAudioCue(RUMMY_AUDIO_CUES.UI_TAP); setDropOpen(true); }} disabled={busy || Boolean(state.result)}><LogOut />DROP</button>
              <button type="button" className="is-discard" onClick={discard} disabled={busy || !privateState.canDiscard || selected.length !== 1}><Hand />DISCARD</button>
              <button type="button" className="is-declare" onClick={declare} disabled={busy || (privateState.drawn ? !selectedDeclarableDiscard : !canExactDeclare)}><Check />{privateState.drawn ? "DISCARD & DECLARE" : "DECLARE"}</button>
            </div>
            <div className={`rummy-validation ${privateState.groupValidation?.valid ? "is-valid" : ""}`} role="status" data-testid="rummy-hand-guidance">
              {privateState.drawn && declarableDiscardIds.length
                ? selectedDeclarableDiscard
                  ? "Ready — Discard & Declare with the selected card"
                  : "Select a valid unmatched card, then Discard & Declare"
                : privateState.groupValidation?.valid
                  ? "Ready to declare"
                  : readableRuleLabel(validationCode, "Arrange every card into valid groups")}
            </div>
          </section>
        )}
      </section>}

      <SocialDrawer
        open={socialOpen}
        onClose={() => setSocialOpen(false)}
        messages={chatMessages}
        onReaction={sendReaction}
        onSupportRequest={onSupportRequest}
        busy={busy}
        musicOn={musicOn}
        musicStatus={musicStatus}
        musicPreset={musicPreset}
        onMusicPreset={setMusicPreset}
        onToggleMusic={toggleMusic}
        reducedMotion={reducedMotion}
      />

      {reconnecting && <div className="rummy-reconnecting" role="status"><RotateCcw />Reconnecting to the authoritative table…</div>}
      {state.result ? (
        <RummyRoyalSettlement
          key={resultKey || "result"}
          result={state.result}
          viewerSeatIndex={viewerSeatIndex}
          onLobby={onExit}
          onCue={(cue) => audioController?.playSettlementCue?.(cue)}
          reducedMotion={reducedMotion}
        />
      ) : dropModalOpen ? (
          <motion.div
            key="drop-confirmation"
            ref={dropDialogRef}
            tabIndex={-1}
            className="rummy-confirm"
            role="dialog"
            aria-modal="true"
            aria-labelledby="rummy-drop-title"
            initial={reducedMotion ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: reducedMotion ? 1 : 0 }}
            transition={{ duration: reducedMotion ? 0 : .2 }}
          >
            <div><h2 id="rummy-drop-title">Drop this hand?</h2><p>{privateState?.dropPenaltyPoints == null ? "The server will apply the configured drop points." : `This drop applies exactly ${privateState.dropPenaltyPoints} points.`}</p><button type="button" onClick={closeDrop}>KEEP PLAYING</button><button type="button" className="is-danger" onClick={async () => { closeDrop(); await performAction("DROP"); }}>DROP HAND</button></div>
          </motion.div>
      ) : null}
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
  const preview = process.env.NODE_ENV !== "production" && game?.demo === true;
  const previewAutoPlay = preview
    && typeof window !== "undefined"
    && new URLSearchParams(window.location.search).get("play") === "1";
  const [categories, setCategories] = useState([]);
  const [balance, setBalance] = useState(null);
  const [lobbyLoading, setLobbyLoading] = useState(true);
  const [lobbyError, setLobbyError] = useState(false);
  const [joinFailure, setJoinFailure] = useState(null);
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const roomRef = useRef(null);
  const actionInFlightRef = useRef(false);
  const pollInFlightRef = useRef(false);
  const pollAbortRef = useRef(null);
  const mutationEpochRef = useRef(0);
  const socialInFlightRef = useRef(false);
  const lastActionFailureRef = useRef(null);
  const rummyAudioRef = useRef(null);
  const previewAutoPlayStartedRef = useRef(false);

  useEffect(() => {
    const controller = createRummyAudioController();
    rummyAudioRef.current = controller;
    return () => {
      if (rummyAudioRef.current === controller) rummyAudioRef.current = null;
      void settleAudio(() => controller.dispose());
    };
  }, []);
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
    setLobbyLoading(true);
    setLobbyError(false);
    if (preview) {
      setCategories(RUMMY_DEMO_CATEGORIES);
      setBalance(RUMMY_DEMO_BALANCE);
      setLobbyLoading(false);
      return;
    }
    const categoriesRequest = api.get("/games/rummy/categories")
      .then(({ data }) => setCategories(data.categories || []))
      .catch((error) => {
        setLobbyError(true);
        toast.error(errMsg(error, "Rummy tables could not be loaded."));
      })
      .finally(() => setLobbyLoading(false));
    const balanceRequest = api.get("/chips/balance")
      .then(({ data }) => {
        const nextBalance = Number(data.balance);
        setBalance(Number.isFinite(nextBalance) ? nextBalance : null);
      })
      .catch(() => setBalance(null));
    await Promise.allSettled([categoriesRequest, balanceRequest]);
  }, [preview]);
  useEffect(() => { loadLobby(); }, [loadLobby]);
  useEffect(() => { roomRef.current = state; }, [state]);

  const join = useCallback(async (categoryId, mode) => {
    if (actionInFlightRef.current) return;
    actionInFlightRef.current = true;
    setBusy(true);
    setJoinFailure(null);
    void settleAudio(() => rummyAudioRef.current?.enableFromGesture?.());
    try {
      // The server's unique active-membership lock makes join idempotent. The
      // explicit key also allows the API transport to retry a no-response join
      // against a healthy alternate host without creating a second seat.
      const joinRequestId = uuid();
      const data = preview
        ? createRummyDemoState(categoryId)
        : (await api.post("/games/rummy/join", { categoryId, mode }, {
          timeout: 22000,
          headers: { "Idempotency-Key": joinRequestId },
        })).data;
      acceptAuthoritativeState(data); setBalance(data.balance ?? balance); setJoinFailure(null); sfx.deal?.();
    } catch (error) {
      const message = error?.response
        ? errMsg(error, "The Rummy table could not be joined.")
        : RUMMY_JOIN_TRANSPORT_MESSAGE;
      setJoinFailure({ categoryId, mode, message });
      toast.error(message);
    } finally { actionInFlightRef.current = false; setBusy(false); }
  }, [acceptAuthoritativeState, balance, preview]);

  useEffect(() => {
    if (
      !previewAutoPlay
      || previewAutoPlayStartedRef.current
      || lobbyLoading
      || state
      || !categories.length
    ) return;
    previewAutoPlayStartedRef.current = true;
    void join(categories[0].id, "PRACTICE");
  }, [categories, join, lobbyLoading, previewAutoPlay, state]);

  const sendAction = useCallback(async (actionType, actionPayload = {}, options = {}) => {
    const current = roomRef.current;
    if (!current || actionInFlightRef.current) return null;
    const actionId = options.actionId || uuid();
    actionInFlightRef.current = true;
    lastActionFailureRef.current = null;
    // Room versions intentionally remain unchanged for private GROUP actions.
    // Advance a local transport epoch before aborting so an older GET that has
    // already resolved at the network layer cannot overwrite its acknowledgement.
    mutationEpochRef.current += 1;
    // A mutation always owns the transport lane. Abort an older GET so its
    // equal-version private payload cannot overwrite this acknowledgement.
    pollAbortRef.current?.abort();
    setBusy(true);
    try {
      const demoState = preview ? applyRummyDemoAction(current, actionType, actionPayload) : null;
      const data = preview
        ? { code: demoState.result?.reason === "VALID_DECLARATION" ? "VALID_DECLARATION" : `${actionType}_ACCEPTED`, state: demoState }
        : (await api.post(`/games/rummy/rooms/${current.roomId}/actions`, {
          roomId: current.roomId, roundId: current.roundId, actionId,
          expectedVersion: current.version, actionType, actionPayload,
          clientTimestamp: Date.now() / 1000,
        }, {
          timeout: 22000,
          headers: { "Idempotency-Key": actionId },
        })).data;
      const next = data.state || { ...data.publicState, privateState: data.privateState };
      acceptAuthoritativeState(next); setReconnecting(false);
      return next;
    } catch (error) {
      const code = errCode(error);
      const message = errMsg(error, "The table rejected that action.");
      lastActionFailureRef.current = { code, message, transport: !error?.response };
      if (["RUMMY_STALE_VERSION", "RUMMY_STALE_ROUND"].includes(code)) setReconnecting(true);
      if (!options.suppressFailureToast) toast.error(message);
      return null;
    } finally { actionInFlightRef.current = false; setBusy(false); }
  }, [acceptAuthoritativeState, preview]);

  const refreshCurrentRoom = useCallback(async (roomId) => {
    const targetRoomId = roomId || roomRef.current?.roomId;
    if (!targetRoomId || preview) return roomRef.current;
    const { data } = await api.get(`/games/rummy/rooms/${targetRoomId}/state`, { timeout: 12000 });
    acceptAuthoritativeState(data);
    setReconnecting(false);
    return data;
  }, [acceptAuthoritativeState, preview]);

  const sendSocialEvent = useCallback(async ({ eventType, message, reactionId }) => {
    const current = roomRef.current;
    if (!current?.roomId || socialInFlightRef.current) return null;
    const requestId = uuid();
    socialInFlightRef.current = true;
    try {
      if (preview) {
        if (["HELP_DESK", "MUSIC_REQUEST"].includes(eventType)) {
          return { accepted: true, requestId, requestStatus: "SUBMITTED" };
        }
        const reaction = RUMMY_REACTIONS.find((item) => item.id === reactionId);
        return {
          accepted: true,
          requestId,
          event: {
            id: requestId,
            eventType,
            reactionId,
            message: message || reaction?.message || "",
            glyph: reaction?.glyph || "",
            sender: { displayName: "You", isBot: false },
            createdAt: new Date().toISOString(),
          },
        };
      }
      const payload = { requestId, eventType };
      if (message) payload.message = message;
      if (reactionId) payload.reactionId = reactionId;
      const { data } = await api.post(`/games/rummy/rooms/${current.roomId}/chat`, payload, { timeout: 12000 });
      return data || null;
    } catch (error) {
      toast.error(errMsg(error, "The table message could not be sent."));
      return null;
    } finally {
      socialInFlightRef.current = false;
    }
  }, [preview]);

  const submitSupportRequest = useCallback(async (kind, request) => {
    const response = await sendSocialEvent({ eventType: kind, message: request });
    if (!response) {
      return {
        accepted: false,
        requestStatus: "FAILED",
        message: "Request could not be sent. Check your connection and try again.",
      };
    }
    return response;
  }, [sendSocialEvent]);

  useEffect(() => {
    if (preview || !state?.roomId || state.state === "ROUND_SETTLED" || state.state === "CANCELLED") return undefined;
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
      const pollEpoch = mutationEpochRef.current;
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
        if (pollEpoch !== mutationEpochRef.current) {
          succeeded = true;
          return;
        }
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
  }, [acceptAuthoritativeState, preview, sendAction, state?.roomId, state?.state]);

  const exit = async () => {
    const current = roomRef.current;
    if (!current) {
      setState(null);
      await loadLobby();
      return;
    }
    if (!current.result && current.state !== "CANCELLED" && current.state !== "ROUND_SETTLED") {
      const actionType = current.state === "WAITING_FOR_PLAYERS" ? "LEAVE" : "DROP";
      const actionId = uuid();
      let released = await sendAction(actionType, {}, { actionId, suppressFailureToast: true });
      let failure = lastActionFailureRef.current;
      let restoredBeforeRetry = false;

      if (!released && RUMMY_EXIT_CONFIRMED_CODES.has(failure?.code)) {
        released = { exitConfirmed: true };
      }

      const shouldRestore = (
        !released
        && (
          ["RUMMY_STALE_VERSION", "RUMMY_STALE_ROUND"].includes(failure?.code)
          || failure?.transport
        )
      );
      if (shouldRestore) {
        try {
          const restored = await refreshCurrentRoom(current.roomId);
          restoredBeforeRetry = true;
          const viewerSeatIndex = Number.isInteger(restored?.privateState?.seatIndex)
            ? restored.privateState.seatIndex
            : current.privateState?.seatIndex;
          const viewerSeat = Number.isInteger(viewerSeatIndex)
            ? restored?.seats?.find((seat) => seat.seatIndex === viewerSeatIndex)
            : null;
          const seatAlreadyReleased = (
            Number.isInteger(viewerSeatIndex)
            && (!viewerSeat || !RUMMY_ACTIVE_SEAT_STATES.has(viewerSeat.status))
          );
          if (
            restored?.result
            || ["ROUND_SETTLED", "CANCELLED"].includes(restored?.state)
            || seatAlreadyReleased
          ) {
            released = restored;
          } else {
            // Reuse the action id: a lost acknowledgement is replay-safe, while
            // a genuinely stale request is retried against the restored version.
            released = await sendAction(actionType, {}, { actionId, suppressFailureToast: true });
            failure = lastActionFailureRef.current;
            if (!released && RUMMY_EXIT_CONFIRMED_CODES.has(failure?.code)) {
              released = { exitConfirmed: true };
            }
          }
        } catch (error) {
          const code = errCode(error);
          if (RUMMY_EXIT_CONFIRMED_CODES.has(code)) {
            released = { exitConfirmed: true };
          } else {
            failure = {
              code,
              message: errMsg(error, "The current table could not be restored yet."),
              transport: !error?.response,
            };
            setReconnecting(true);
          }
        }
      }

      if (!released) {
        setReconnecting(true);
        toast.error(
          restoredBeforeRetry
            ? "Your current table was restored, but leaving was not confirmed. It remains open here so your seat and chips stay protected; try again when the connection is stable."
            : failure?.code === "RUMMY_MODE_SWITCH_BLOCKED"
            ? "Your current table is still active. Resume it here, then leave before changing mode."
            : "The server did not confirm that you left. Your current table remains open here so your seat and chips stay protected. Try again when the connection is stable.",
        );
        return;
      }
    }
    setState(null);
    roomRef.current = null;
    setReconnecting(false);
    await loadLobby();
  };

  if (!state) return (
    <RummyLandscapeGuard onExit={() => navigate(`/games/${game.slug}`)}>
      <CategoryLobby categories={categories} balance={balance} busy={busy} loading={lobbyLoading} error={lobbyError} joinFailure={joinFailure} preview={preview} onJoin={join} onRetry={loadLobby} onExit={() => navigate(`/games/${game.slug}`)} />
    </RummyLandscapeGuard>
  );
  return (
    <RummyLandscapeGuard onExit={exit}>
      <RummyTableBoundary state={state} onExit={exit}>
        <RummyTable state={state} busy={busy} reconnecting={reconnecting} sendAction={sendAction} sendSocialEvent={sendSocialEvent} onSupportRequest={submitSupportRequest} onExit={exit} audioController={rummyAudioRef.current} />
      </RummyTableBoundary>
    </RummyLandscapeGuard>
  );
}
