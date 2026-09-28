import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { Link } from "react-router-dom";
import { Volume2, VolumeX } from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { errMsg } from "@/lib/api";
import ChickenRoadView from "./ChickenRoadView";
import { createChickenRoadLiveClient } from "./chickenRoadLiveClient";
import { createChickenRoadAudio } from "./chickenRoadAudio";
import { chickenRoadCollisionChances, verifyChickenRoadFairness } from "./chickenRoadFairness";

const HOP_MS = 480;
const SOUND_KEY = "chakri.chicken-road.sound-muted";
const chips = (amount) => Number.isSafeInteger(amount) ? amount.toLocaleString("en-IN") : "—";
const roundFrom = (state) => state?.active_round || state?.latest_round || null;
const phaseOf = (round) => ({ PLAYING: "playing", CRASHED: "crashed", CASHED: "cashed_out" }[round?.status] || "idle");
const availability = (state) => state.rules.approval !== "APPROVED" ? "unavailable" : state.enabled ? "ready" : "paused";
const failureConnection = (failure) => {
  const code = failure?.response?.data?.detail?.code || failure?.code;
  if (["CHICKEN_ROAD_WALLET_RECONCILIATION_REQUIRED", "GAME_WALLET_MIRROR_MISMATCH", "WALLET_SOURCE_UNRESOLVED", "WALLET_SOURCE_AMBIGUOUS", "WALLET_SOURCE_UNCERTIFIED"].includes(code)) return "wallet-reconciliation";
  if (code === "CHICKEN_ROAD_WALLET_UNAVAILABLE") return "wallet-unavailable";
  return ["CHICKEN_ROAD_DISABLED", "GAME_COMING_SOON", "CHICKEN_ROAD_EXPOSURE_UNAVAILABLE", "CHICKEN_ROAD_STORAGE_UNAVAILABLE", "CHICKEN_ROAD_RULES_UNAVAILABLE"].includes(code) ? "unavailable" : "offline";
};
// On touch devices prefer screen orientation so the keyboard cannot imitate a
// rotation. Desktop/resizable windows fall back to their layout dimensions.
const isPortrait = () => {
  const orientation = window.screen?.orientation?.type;
  if (orientation && window.matchMedia?.("(pointer: coarse)")?.matches) return orientation.startsWith("portrait");
  return window.innerHeight > window.innerWidth;
};
const savedMute = () => { try { return localStorage.getItem(SOUND_KEY) === "true"; } catch { return false; } };
const collisionText = (chance) => `${(100 * chance.numerator / chance.denominator).toFixed(2)}% (${chance.numerator}/${chance.denominator})`;
const chancesFor = (version, item) => {
  try { return chickenRoadCollisionChances(version, item.difficulty || item.id, item.multipliers_hundredths); }
  catch { return null; }
};
const inactivityRule = <p>After 15 minutes without a crossing or cash-out, an active round is automatically cashed out at its current safe lane. This pays the current cash-out amount, not a new crossing. Reconnecting does not reset that deadline.</p>;

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
  const [fairness, setFairness] = useState(null);
  const [visibleLane, setVisibleLane] = useState(0);
  const [moving, setMoving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [animateOutcome, setAnimateOutcome] = useState(false);
  const [compact, setCompact] = useState(() => window.innerWidth <= 600);
  const [portrait, setPortrait] = useState(isPortrait);
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
  const fairnessEpoch = useRef(0);

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
    const updateOrientation = () => setPortrait(isPortrait());
    window.addEventListener("resize", updateOrientation);
    window.addEventListener("orientationchange", updateOrientation);
    window.screen?.orientation?.addEventListener?.("change", updateOrientation);
    return () => {
      window.removeEventListener("resize", updateOrientation);
      window.removeEventListener("orientationchange", updateOrientation);
      window.screen?.orientation?.removeEventListener?.("change", updateOrientation);
    };
  }, []);

  useEffect(() => { if (portrait) setDialog(null); }, [portrait]);

  useEffect(() => {
    mounted.current = true;
    busy.current = false;
    snapshotRef.current = null;
    setSnapshot(null); setDisplayRound(null); setPending(null); setStake(""); setDifficulty("");
    setVisibleLane(0); setMoving(false); setAnimateOutcome(false); setError("");
    fairnessEpoch.current += 1; setFairness(null);
    if (!auth?.loading && client) refresh();
    else setConnection(auth?.loading ? "loading" : "auth");
    return () => {
      mounted.current = false;
      requestEpoch.current += 1;
      fairnessEpoch.current += 1;
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
  const proofRound = snapshot?.latest_round && ["CRASHED", "CASHED"].includes(snapshot.latest_round.status) ? snapshot.latest_round : null;
  const checkedFairness = fairness?.roundId === proofRound?.id && fairness?.version === proofRound?.version ? fairness : null;

  const verifyLastRound = async () => {
    if (!client || !proofRound || checkedFairness?.status === "checking") return;
    const terminal = JSON.parse(JSON.stringify(proofRound));
    const epoch = ++fairnessEpoch.current;
    const identity = { roundId: terminal.id, version: terminal.version };
    setFairness({ ...identity, status: "checking" });
    try {
      const proof = await client.getFairness(terminal.id);
      const result = await verifyChickenRoadFairness(proof, terminal);
      if (mounted.current && fairnessEpoch.current === epoch) setFairness({ ...identity, status: "verified", result, proof });
    } catch (failure) {
      if (mounted.current && fairnessEpoch.current === epoch) setFairness({ ...identity, status: "failed", message: errMsg(failure, "The proof could not be verified. Please try again.") });
    }
  };

  const runAction = async (type, retry = false) => {
    // Rotation never starts/replays a wager. Cash-out is a protective exit and
    // remains available for an existing round, including its original retry.
    if (isPortrait() && (retry ? pending?.kind !== "cashout" : type !== "CASH_OUT")) return;
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
      if (failure.code === "CHICKEN_ROAD_RULES_CHANGED") {
        // A confirmed preparation-only mismatch is safe to retire. Refresh by
        // GET only; the changed rules always require a separate Play gesture.
        try {
          const next = await client.reconcile();
          if (!mounted.current || requestEpoch.current !== epoch) return;
          adopt(next.state); setPending(next.pending);
          setConnection(next.pending ? "pending" : availability(next.state));
          setError(failure.message);
        } catch (refreshFailure) {
          if (!mounted.current || requestEpoch.current !== epoch) return;
          setConnection(failureConnection(refreshFailure));
          setError(`${failure.message} Reconnect to load the current rules.`);
          try { setPending(client.readPending()); } catch { setPending({ kind: "unknown" }); }
        }
        busy.current = false;
        return;
      }
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
  const locked = portrait || !ready || active || moving || Boolean(pending);
  const presets = rules ? Array.from(new Set([rules.min_stake, rules.min_stake + rules.stake_step, rules.min_stake + 2 * rules.stake_step, rules.max_stake])).filter((value) => value <= rules.max_stake) : [];
  const pendingPlay = pending?.kind === "prepare" ? pending.intent : pending?.kind === "play" ? pending.body : null;
  const pendingDescription = pendingPlay ? `Pending play: ${chips(pendingPlay.amount)} chips · ${rules?.difficulties.find((item) => item.id === pendingPlay.difficulty)?.label || pendingPlay.difficulty}.`
    : pending?.kind === "go" ? "Pending action: one crossing." : pending?.kind === "cashout" ? "Pending action: cash out." : "";
  const statusPanel = connection === "ready" || moving ? null : <>
    <strong>{connection === "auth" ? "Sign in to play" : connection === "wallet-reconciliation" ? "Your wallet needs a review" : connection === "wallet-unavailable" ? "Wallet service is temporarily unavailable" : connection === "unavailable" ? "Chicken Road is unavailable" : connection === "paused" ? "New crossings are paused" : connection === "pending" ? "Action awaiting confirmation" : connection === "submitting" ? "Confirming your action…" : connection === "offline" ? "Connection interrupted" : "Connecting to Chicken Road…"}</strong>
    <span>{connection === "auth" ? "Use your player account to continue." : ["wallet-unavailable", "wallet-reconciliation"].includes(connection) ? error || "Your gameplay wallet is not ready. Please contact support." : connection === "unavailable" ? error || "Please check back when the game is available." : connection === "paused" ? active ? "You can still cash out your active round." : "Please check back when the game resumes." : pending ? "Your original action is saved. Check its status before continuing." : connection === "submitting" ? "Waiting for the server’s result." : "Your balance and round will appear after the server confirms them."}</span>
    {connection === "wallet-unavailable" && <span>Please check again shortly, or contact support if this continues.</span>}
    {connection === "wallet-reconciliation" && <span>Please contact support to reconcile your account’s gameplay wallet. New bets remain blocked until it is ready.</span>}
    {pendingDescription && <span>{pendingDescription}</span>}
    {connection === "auth" ? <a href="/login" className="road-top-button">Sign in</a>
      : !["loading", "submitting", "reconnecting"].includes(connection) && <button className="road-top-button" onClick={refresh}>Check round</button>}
    {pending && pending.kind !== "unknown" && (!portrait || pending.kind === "cashout") && !["loading", "submitting", "reconnecting"].includes(connection)
      && <button className="road-top-button" onClick={() => runAction(null, true)}>Retry same action</button>}
  </>;
  const riskRound = snapshot?.active_round;
  const risks = riskRound ? chancesFor(riskRound.rules_version, riskRound) : selected && chancesFor(rules.version, selected);
  const nextLane = riskRound ? riskRound.lane + 1 : 1;
  const nextRisk = risks?.[nextLane - 1];
  const riskDisclosure = nextRisk ? <p>Next crossing: lane {nextLane} · Collision chance {collisionText(nextRisk)}. This is conditional on reaching this lane{riskRound ? `, under your round's locked rules (${riskRound.rules_version})` : ""}.</p> : <p>The next crossing’s collision chance is unavailable until its rules can be verified.</p>;
  const fairnessDisclosure = <section aria-label="Round verification"><h3>Check the last settled round</h3><p>Before Play, the server commits to a seed hash; your browser then creates a client seed. The server seed is revealed only after settlement. This browser check reproduces the commitment, attempted lane outcomes and payout using the round’s locked rules. It is not independent certification, and cannot prove seed freshness, commitment timing or wallet funding.</p>
    {proofRound ? <><p>Round: {proofRound.id} · Rules: {proofRound.rules_version}</p><button className="road-top-button" onClick={verifyLastRound} disabled={checkedFairness?.status === "checking"}>{checkedFairness?.status === "checking" ? "Checking proof…" : "Verify last round"}</button>
      <p role="status">{checkedFairness?.status === "verified" ? `Verified mathematical consistency for ${checkedFairness.result.checkedLanes} attempted lane(s), the seed commitment and recorded payout of ${chips(checkedFairness.result.payout)} chips.` : checkedFairness?.status === "failed" ? `Not verified: ${checkedFairness.message}` : "No successful verification has been completed for this round."}</p>
      {checkedFairness?.status === "verified" && <details><summary>Revealed proof</summary><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{JSON.stringify(checkedFairness.proof, null, 2)}</pre></details>}</>
      : <p>A terminal round is required. Active-round seeds are never requested or revealed here.</p>}</section>;
  const dialogContent = dialog === "help" ? <><ol><li>Choose a stake and difficulty, then press <b>Play</b> to attempt the first crossing.</li><li>Press <b>GO</b> for another crossing, or <b>CASH OUT</b> to collect the amount shown.</li><li>A collision ends the round. Reaching the final lane automatically collects the final payout.</li></ol><p>Stake and difficulty remain fixed throughout a round. Results and your balance are confirmed by the server.</p>{riskDisclosure}{inactivityRule}{fairnessDisclosure}</>
    : dialog === "auto" ? <p>Crossings use Play, GO and Cash Out. Automatic betting is not available.</p>
      : dialog === "menu" ? <><p>Chakri.Casino · Chicken Road</p><Link className="road-top-button" to="/games">Back to lobby</Link><button className="road-top-button" onClick={() => setDialog("help")}>How to play</button><button className="road-top-button" onClick={() => setDialog("rules")}>Rules & limits</button><button className="road-top-button" onClick={toggleSound} aria-pressed={!muted} aria-label={muted ? "Turn game sounds on" : "Mute game sounds"}>{muted ? <VolumeX size={18} /> : <Volume2 size={18} />}<span>Sound {muted ? "off" : "on"}</span></button><p>Animations follow your device’s reduced-motion preference.</p></>
        : rules ? <>{snapshot.active_round?.rules_version && snapshot.active_round.rules_version !== rules.version && <p>Your current round uses its locked rules ({snapshot.active_round.rules_version}). The rules below apply only to new rounds; your current payout table and cash-out amount are unchanged.</p>}{riskDisclosure}<p>Stake: {chips(rules.min_stake)}–{chips(rules.max_stake)} chips, in steps of {chips(rules.stake_step)}.</p>{Number.isFinite(rules.rtp_bps) && <p>Theoretical return to player: {rules.rtp_bps / 100}%. This is a long-run average, not a promise for an individual round.</p>}<p>Multipliers show the total amount returned, including your stake. A collision returns no payout. The displayed cash-out amount comes from the server. Collision chances below are conditional on reaching each lane, rounded to two decimals; exact fractions are included.</p>{rules.difficulties.map((item) => <div key={item.id}><p><b>{item.label}:</b> {item.multipliers_hundredths.map((value) => `${(value / 100).toFixed(2)}×`).join(" · ")}</p><p>{chancesFor(rules.version, item)?.map((chance, index) => `Lane ${index + 1}: ${collisionText(chance)}`).join(" · ") || "Collision chances unavailable for these rules."}</p></div>)}{inactivityRule}{fairnessDisclosure}</>
          : <p>The game rules are unavailable while disconnected.</p>;

  return <ChickenRoadView
    rootRef={rootRef} phase={phase} roundKey={displayRound?.id} lane={displayRound?.lane || 0}
    landscapeOnly={portrait} activeRound={active}
    multipliers={multipliers} difficulties={rules?.difficulties || []}
    balanceText={chips(snapshot?.balance)} balanceLabel={snapshot ? `Balance ${chips(snapshot.balance)} chips` : "Balance unavailable"}
    stake={stake} presets={presets} difficulty={difficulty} visibleLane={visibleLane}
    camera={Math.max(0, visibleLane - (compact ? 1 : 2))} moving={moving} resetting={resetting} hidden={hidden}
    escapeFromLane={moving && snapshot?.active_round ? visibleLane - 1 : 0}
    locked={locked} playDisabled={portrait || !ready || !stakeValid || !selected || Boolean(pending)} actionDisabled={portrait || !ready || Boolean(pending)}
    cashOutDisabled={!canCashOut} goDisabled={portrait || !ready || Boolean(pending)}
    cashOutText={chips(snapshot?.active_round?.cashout_amount)} animateOutcome={animateOutcome}
    result={displayRound && phase !== "playing" && connection === "ready" ? {
      type: phase === "crashed" ? "error" : "success",
      title: phase === "crashed" ? "Oh, cluck!" : `${(displayRound.multiplier_hundredths / 100).toFixed(2)}x · Cashed out`,
      detail: phase === "crashed" ? "The crossing ended. Play again when you’re ready." : `+${chips(displayRound.payout)} chips`,
    } : null}
    error={error} statusPanel={statusPanel} chanceHint={nextRisk ? `Next lane ${nextLane} collision: ${collisionText(nextRisk)}` : "Open Game rules for payout tables and verification."}
    historyText={snapshot?.latest_round ? `Last round: ${snapshot.latest_round.status === "CRASHED" ? "collision" : `+${chips(snapshot.latest_round.payout)} chips`}` : "18+ · Live game"}
    onStakeChange={(value) => { setStake(value); setError(""); }}
    onMinimum={() => setStake(String(rules.min_stake))}
    onMaximum={() => setStake(String(Math.floor(Math.min(rules.max_stake, snapshot.balance) / rules.stake_step) * rules.stake_step))}
    onPreset={(value) => setStake(String(value))}
    onDifficulty={(id) => { setDifficulty(id); setDisplayRound(null); setVisibleLane(0); setAnimateOutcome(false); setError(""); }}
    onAction={runAction} onFullscreen={fullscreen} onDialogChange={setDialog}
    dialog={dialog ? { title: dialog === "help" ? "How to play" : dialog === "menu" ? "Chicken Road" : dialog === "auto" ? "Auto play" : "Rules for new rounds", content: dialogContent } : null}
  />;
}
