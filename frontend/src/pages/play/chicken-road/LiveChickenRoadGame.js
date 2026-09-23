import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { Volume2, VolumeX } from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { errMsg } from "@/lib/api";
import ChickenRoadView from "./ChickenRoadView";
import { createChickenRoadLiveClient } from "./chickenRoadLiveClient";
import { createChickenRoadAudio } from "./chickenRoadAudio";

const HOP_MS = 480;
const SOUND_KEY = "chakri.chicken-road.sound-muted";
const chips = (amount) => Number.isSafeInteger(amount) ? amount.toLocaleString("en-IN") : "—";
const roundFrom = (state) => state?.active_round || state?.latest_round || null;
const phaseOf = (round) => ({ PLAYING: "playing", CRASHED: "crashed", CASHED: "cashed_out" }[round?.status] || "idle");
const availability = (state) => state.rules.approval !== "APPROVED" ? "unavailable" : state.enabled ? "ready" : "paused";
const failureConnection = (failure) => failure?.response?.data?.detail?.code === "CHICKEN_ROAD_DISABLED" ? "unavailable" : "offline";
const savedMute = () => { try { return localStorage.getItem(SOUND_KEY) === "true"; } catch { return false; } };

/** Live-only controller. The server supplies every outcome, amount and ladder. */
export default function LiveChickenRoadGame() {
  const auth = useAuth();
  const userId = auth?.user?.id ? String(auth.user.id) : null;
  const setUser = auth?.setUser;
  const client = useMemo(() => userId ? createChickenRoadLiveClient({ userId }) : null, [userId]);
  const [snapshot, setSnapshot] = useState(null);
  const [displayRound, setDisplayRound] = useState(null);
  const [connection, setConnection] = useState("loading");
  const [pending, setPending] = useState(null);
  const [stake, setStake] = useState("");
  const [difficulty, setDifficulty] = useState("");
  const [error, setError] = useState("");
  const [dialog, setDialog] = useState(null);
  const [visibleLane, setVisibleLane] = useState(0);
  const [moving, setMoving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [animateOutcome, setAnimateOutcome] = useState(false);
  const [compact, setCompact] = useState(() => window.innerWidth <= 600);
  const [reduceMotion, setReduceMotion] = useState(false);
  const [muted, setMuted] = useState(savedMute);
  const [hidden, setHidden] = useState(() => document.hidden);
  const rootRef = useRef(null);
  const mounted = useRef(false);
  const busy = useRef(false);
  const requestEpoch = useRef(0);
  const soundEpoch = useRef(0);
  const mutedRef = useRef(muted);
  const audioRef = useRef(null);
  const hopTimer = useRef(null);
  const refreshRef = useRef(null);
  const snapshotRef = useRef(null);

  const updateBalance = useCallback((balance) => {
    setUser?.((current) => current && String(current.id) === userId ? { ...current, chip_balance: balance } : current);
  }, [setUser, userId]);

  const adopt = useCallback((state) => {
    const round = roundFrom(state);
    snapshotRef.current = state;
    setSnapshot(state);
    setDisplayRound(round);
    setVisibleLane(round?.lane || 0);
    setMoving(false);
    setAnimateOutcome(false);
    setStake((current) => state.active_round ? String(state.active_round.amount) : current || String(state.rules.min_stake));
    setDifficulty((current) => state.active_round?.difficulty
      || (state.rules.difficulties.some((item) => item.id === current) ? current : state.rules.difficulties[0].id));
    updateBalance(state.balance);
  }, [updateBalance]);

  const refresh = useCallback(async () => {
    if (!client || busy.current) return;
    const epoch = ++requestEpoch.current;
    busy.current = true;
    setConnection(snapshotRef.current ? "reconnecting" : "loading");
    setError("");
    try {
      const next = await client.reconcile();
      if (!mounted.current || requestEpoch.current !== epoch) return;
      adopt(next.state);
      setPending(next.pending);
      setConnection(next.pending ? "pending" : availability(next.state));
      if (next.rejection) setError(next.rejection.message);
    } catch (failure) {
      if (!mounted.current || requestEpoch.current !== epoch) return;
      setConnection(failureConnection(failure));
      setError(errMsg(failure, "The connection was interrupted. Reconnect to check your round."));
      try { setPending(client.readPending()); } catch { setPending({ kind: "unknown" }); }
    } finally {
      if (mounted.current && requestEpoch.current === epoch) busy.current = false;
    }
  }, [client, adopt]);
  refreshRef.current = refresh;

  useEffect(() => {
    mounted.current = true;
    busy.current = false;
    snapshotRef.current = null;
    setSnapshot(null); setDisplayRound(null); setPending(null); setStake(""); setDifficulty("");
    setVisibleLane(0); setMoving(false); setAnimateOutcome(false); setError("");
    if (!auth?.loading && client) refresh();
    else setConnection(auth?.loading ? "loading" : "auth");
    return () => {
      mounted.current = false;
      requestEpoch.current += 1;
      soundEpoch.current += 1;
      clearTimeout(hopTimer.current);
      audioRef.current?.stopAll();
      // Do not abort a financial POST or discard its durable action on unmount.
    };
  }, [client, auth?.loading, refresh]);

  useEffect(() => {
    const audio = createChickenRoadAudio();
    audioRef.current = audio;
    audio.setMuted(mutedRef.current);
    const visibility = () => {
      setHidden(document.hidden);
      if (document.hidden) { soundEpoch.current += 1; audio.stopAll(); }
      else refreshRef.current?.();
    };
    const online = () => refreshRef.current?.();
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("online", online);
    return () => {
      soundEpoch.current += 1;
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("online", online);
      audio.dispose();
      audioRef.current = null;
    };
  }, []);

  useEffect(() => {
    const compactQuery = window.matchMedia?.("(max-width: 600px)");
    const motionQuery = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const update = () => { setCompact(Boolean(compactQuery?.matches)); setReduceMotion(Boolean(motionQuery?.matches)); };
    update();
    compactQuery?.addEventListener?.("change", update);
    motionQuery?.addEventListener?.("change", update);
    return () => { compactQuery?.removeEventListener?.("change", update); motionQuery?.removeEventListener?.("change", update); };
  }, []);

  const toggleSound = () => {
    const next = !mutedRef.current;
    mutedRef.current = next; setMuted(next); soundEpoch.current += 1;
    audioRef.current?.setMuted(next);
    if (!next) audioRef.current?.unlock();
    try { localStorage.setItem(SOUND_KEY, String(next)); } catch { /* Preference storage is optional. */ }
  };

  const rules = snapshot?.rules;
  const active = Boolean(snapshot?.active_round);
  const selected = rules?.difficulties.find((item) => item.id === difficulty);
  const amount = Number(stake);
  const stakeValid = /^\d+$/.test(stake) && Number.isSafeInteger(amount) && rules
    && amount >= rules.min_stake && amount <= Math.min(rules.max_stake, snapshot.balance)
    && amount % rules.stake_step === 0;
  const approved = rules?.approval === "APPROVED";
  const ready = connection === "ready" && snapshot?.enabled === true && approved;
  const canCashOut = approved && ["ready", "paused"].includes(connection) && active && !pending && !moving;

  const runAction = async (type, retry = false) => {
    if (busy.current || !client || (!retry && (type === "CASH_OUT" ? !canCashOut : !ready)) || (!retry && type === "PLAY" && (!stakeValid || !selected))) return;
    if (!retry && type !== "PLAY" && !snapshotRef.current?.active_round) return;
    busy.current = true;
    const epoch = ++requestEpoch.current;
    const soundToken = ++soundEpoch.current;
    const audio = audioRef.current;
    audio?.stopAll();
    const soundReady = !mutedRef.current && !document.hidden ? audio?.unlock() : Promise.resolve(false);
    setError(""); setConnection("submitting");
    let receipt = null;
    try {
      receipt = retry ? await client.retryPending()
        : type === "PLAY" ? await client.play({ amount, difficulty, rulesVersion: rules.version })
          : await client.advance(type === "HOP" ? "go" : "cashout", snapshotRef.current.active_round);
      const next = await client.getState();
      if (!mounted.current || requestEpoch.current !== epoch) return;
      setPending(null);
      const actual = roundFrom(next);
      const sameReceipt = actual?.id === receipt.round.id && actual?.version === receipt.round.version;
      if (receipt.result === "cashed_out" || !sameReceipt || reduceMotion || document.hidden) {
        adopt(next); setConnection(availability(next)); busy.current = false;
        return;
      }
      const newRound = snapshotRef.current?.active_round?.id !== actual.id;
      if (newRound) {
        flushSync(() => { setDisplayRound(null); setVisibleLane(0); setResetting(true); });
        rootRef.current?.getBoundingClientRect();
        flushSync(() => setResetting(false));
      }
      snapshotRef.current = next; setSnapshot(next); updateBalance(next.balance);
      setDifficulty(actual.difficulty); setStake(String(actual.amount));
      setAnimateOutcome(true); setVisibleLane(actual.lane); setMoving(true);
      const started = performance.now();
      const startSound = () => {
        const remaining = HOP_MS - (performance.now() - started);
        if (mounted.current && requestEpoch.current === epoch && soundEpoch.current === soundToken && !mutedRef.current && !document.hidden && remaining > 60) audio?.playWalk(remaining);
      };
      Promise.resolve(soundReady).then((unlocked) => { if (unlocked) startSound(); });
      hopTimer.current = setTimeout(() => {
        if (!mounted.current || requestEpoch.current !== epoch) return;
        setDisplayRound(actual); setMoving(false); setConnection(availability(next)); busy.current = false;
        if (actual.status === "CRASHED" && soundEpoch.current === soundToken && !mutedRef.current && !document.hidden) audio?.playFire();
      }, HOP_MS);
    } catch (failure) {
      if (!mounted.current || requestEpoch.current !== epoch) return;
      soundEpoch.current += 1; audio?.stopAll();
      // A successful mutation can be followed by a failed state read. Its
      // receipt is authoritative, but actions stay locked until reconnection.
      if (receipt && snapshotRef.current) {
        const known = { ...snapshotRef.current, balance: receipt.balance,
          active_round: receipt.round.status === "PLAYING" ? receipt.round : null, latest_round: receipt.round };
        adopt(known);
      }
      setError(errMsg(failure, "The action is not confirmed yet. Check its status before continuing."));
      setConnection(failureConnection(failure));
      try { setPending(client.readPending()); } catch { setPending({ kind: "unknown" }); }
      busy.current = false;
      // Deliberately do not retry a POST, replace an operation id, or infer a loss.
    }
  };

  const fullscreen = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (rootRef.current?.requestFullscreen) await rootRef.current.requestFullscreen();
      else setError("Fullscreen is not supported here. Turn your device sideways for a wider road.");
    } catch { setError("Fullscreen could not be opened."); }
  };

  const phase = phaseOf(displayRound);
  const multipliers = (displayRound?.multipliers_hundredths || selected?.multipliers_hundredths || []).map((value) => value / 100);
  const locked = !ready || active || moving || Boolean(pending);
  const presets = rules ? Array.from(new Set([rules.min_stake, rules.min_stake + rules.stake_step, rules.min_stake + 2 * rules.stake_step, rules.max_stake])).filter((value) => value <= rules.max_stake) : [];
  const pendingPlay = pending?.kind === "prepare" ? pending.intent : pending?.kind === "play" ? pending.body : null;
  const pendingDescription = pendingPlay ? `Pending play: ${chips(pendingPlay.amount)} chips · ${rules?.difficulties.find((item) => item.id === pendingPlay.difficulty)?.label || pendingPlay.difficulty}.`
    : pending?.kind === "go" ? "Pending action: one crossing." : pending?.kind === "cashout" ? "Pending action: cash out." : "";
  const statusPanel = connection === "ready" || moving ? null : <>
    <strong>{connection === "auth" ? "Sign in to play" : connection === "unavailable" ? "Chicken Road is unavailable" : connection === "paused" ? "New crossings are paused" : connection === "pending" ? "Action awaiting confirmation" : connection === "submitting" ? "Confirming your action…" : connection === "offline" ? "Connection interrupted" : "Connecting to Chicken Road…"}</strong>
    <span>{connection === "auth" ? "Use your player account to continue." : connection === "unavailable" ? "Please check back when the game is available." : connection === "paused" ? active ? "You can still cash out your active round." : "Please check back when the game resumes." : pending ? "Your original action is saved. Check its status before continuing." : connection === "submitting" ? "Waiting for the server’s result." : "Your balance and round will appear after the server confirms them."}</span>
    {pendingDescription && <span>{pendingDescription}</span>}
    {connection === "auth" ? <a href="/login" className="road-top-button">Sign in</a>
      : !["loading", "submitting", "reconnecting"].includes(connection) && <button className="road-top-button" onClick={refresh}>Check round</button>}
    {pending && pending.kind !== "unknown" && !["loading", "submitting", "reconnecting"].includes(connection)
      && <button className="road-top-button" onClick={() => runAction(null, true)}>Retry same action</button>}
  </>;
  const dialogContent = dialog === "help" ? <><ol><li>Choose a stake and difficulty, then press <b>Play</b> to attempt the first crossing.</li><li>Press <b>GO</b> for another crossing, or <b>CASH OUT</b> to collect the amount shown.</li><li>A collision ends the round. Reaching the final lane automatically collects the final payout.</li></ol><p>Stake and difficulty remain fixed throughout a round. Results and your balance are confirmed by the server.</p></>
    : dialog === "auto" ? <p>Crossings use Play, GO and Cash Out. Automatic betting is not available.</p>
      : dialog === "menu" ? <><p>Chakri.Casino · Chicken Road</p><button className="road-top-button" onClick={() => setDialog("help")}>How to play</button><button className="road-top-button" onClick={() => setDialog("rules")}>Rules & limits</button><button className="road-top-button" onClick={toggleSound} aria-pressed={!muted} aria-label={muted ? "Turn game sounds on" : "Mute game sounds"}>{muted ? <VolumeX size={18} /> : <Volume2 size={18} />}<span>Sound {muted ? "off" : "on"}</span></button><p>Animations follow your device’s reduced-motion preference.</p></>
        : rules ? <><p>Stake: {chips(rules.min_stake)}–{chips(rules.max_stake)} chips, in steps of {chips(rules.stake_step)}.</p>{Number.isFinite(rules.rtp_bps) && <p>Theoretical return to player: {rules.rtp_bps / 100}%. This is a long-run average, not a promise for an individual round.</p>}<p>Multipliers show the total amount returned, including your stake. A collision returns no payout. The displayed cash-out amount comes from the server.</p>{rules.difficulties.map((item) => <p key={item.id}><b>{item.label}:</b> {item.multipliers_hundredths.map((value) => `${(value / 100).toFixed(2)}×`).join(" · ")}</p>)}</>
          : <p>The game rules are unavailable while disconnected.</p>;

  return <ChickenRoadView
    rootRef={rootRef} phase={phase} roundKey={displayRound?.id} lane={displayRound?.lane || 0}
    multipliers={multipliers} difficulties={rules?.difficulties || []}
    balanceText={chips(snapshot?.balance)} balanceLabel={snapshot ? `Balance ${chips(snapshot.balance)} chips` : "Balance unavailable"}
    stake={stake} presets={presets} difficulty={difficulty} visibleLane={visibleLane}
    camera={Math.max(0, visibleLane - (compact ? 1 : 2))} moving={moving} resetting={resetting} hidden={hidden}
    locked={locked} playDisabled={!ready || !stakeValid || !selected || Boolean(pending)} actionDisabled={!ready || Boolean(pending)}
    cashOutDisabled={!canCashOut} goDisabled={!ready || Boolean(pending)}
    cashOutText={chips(snapshot?.active_round?.cashout_amount)} animateOutcome={animateOutcome}
    result={displayRound && phase !== "playing" && connection === "ready" ? {
      type: phase === "crashed" ? "error" : "success",
      title: phase === "crashed" ? "Oh, cluck!" : `${(displayRound.multiplier_hundredths / 100).toFixed(2)}x · Cashed out`,
      detail: phase === "crashed" ? "The crossing ended. Play again when you’re ready." : `+${chips(displayRound.payout)} chips`,
    } : null}
    error={error} statusPanel={statusPanel} chanceHint="Open Game rules to see the server’s payout tables."
    historyText={snapshot?.latest_round ? `Last round: ${snapshot.latest_round.status === "CRASHED" ? "collision" : `+${chips(snapshot.latest_round.payout)} chips`}` : "18+ · Live game"}
    onStakeChange={(value) => { setStake(value); setError(""); }}
    onMinimum={() => setStake(String(rules.min_stake))}
    onMaximum={() => setStake(String(Math.floor(Math.min(rules.max_stake, snapshot.balance) / rules.stake_step) * rules.stake_step))}
    onPreset={(value) => setStake(String(value))}
    onDifficulty={(id) => { setDifficulty(id); setDisplayRound(null); setVisibleLane(0); setAnimateOutcome(false); setError(""); }}
    onAction={runAction} onFullscreen={fullscreen} onDialogChange={setDialog}
    dialog={dialog ? { title: dialog === "help" ? "How to play" : dialog === "menu" ? "Chicken Road" : dialog === "auto" ? "Auto play" : "Game rules", content: dialogContent } : null}
  />;
}
