/* eslint-disable react-hooks/exhaustive-deps */
import React, { useCallback, useEffect, useMemo, useRef } from "react";
import { toast } from "react-toastify";
import { authHeaders, config, gameAssetUrl } from "./config";
import { playGameSound } from "./sound";
import {
  UserType,
  BettedUserType,
  GameHistory,
  ContextType,
  ContextDataType,
  MsgUserType,
  GameBetLimit,
  UserStatusType,
  SeedDetailsType,
  init_state as sharedInitState,
  init_userInfo,
} from "./utils/interfaces";

type PanelKey = "f" | "s";

const Context = React.createContext<ContextType>(null!);

let cashOutImplementation: (at: number, index: PanelKey) => void = () => undefined;
export const callCashOut = (at: number, index: PanelKey) => cashOutImplementation(at, index);
let cancelBetImplementation: (index: PanelKey) => void = () => undefined;
export const callCancelBet = (index: PanelKey) => cancelBetImplementation(index);

const detailMessage = (payload: any, fallback: string) => {
  const detail = payload?.detail;
  if (typeof detail === "string") return detail;
  if (detail?.message) return detail.message;
  return fallback;
};

const avatarFor = (name: string, index: number) => {
  let hash = index + 5;
  for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) % 72;
  return gameAssetUrl(`avatars/av-${(Math.abs(hash) % 72) + 1}.png`);
};

const flightTimeFor = (multiplier: number) => {
  const wanted = Math.max(1, multiplier || 1);
  let low = 0;
  let high = 180;
  for (let i = 0; i < 60; i += 1) {
    const t = (low + high) / 2;
    const value = 1 + 0.06 * t + (0.06 * t) ** 2 - (0.04 * t) ** 3 + (0.04 * t) ** 4;
    if (value < wanted) low = t;
    else high = t;
  }
  return (low + high) / 2;
};

const fetchApi = async (path: string, init: RequestInit = {}) => {
  const response = await fetch(`${config.api}${path}`, {
    ...init,
    headers: { ...authHeaders(), ...(init.headers || {}) },
  });
  let data: any = {};
  try {
    data = await response.json();
  } catch (_error) {
    data = {};
  }
  if (response.status === 401) {
    window.parent.location.assign("/login");
    throw new Error("Your session has expired");
  }
  const code = data?.detail?.code;
  if (response.status === 403 && ["SELF_EXCLUDED", "MARKET_BLOCKED", "AGE_NOT_VERIFIED", "UNDERAGE"].includes(code)) {
    window.parent.location.assign("/account-closed");
    throw new Error(data.detail.message || "This account is not permitted to play");
  }
  if (response.status === 503 && code === "MAINTENANCE") {
    window.parent.location.assign("/maintenance");
    throw new Error(data.detail.message || "The game is under maintenance");
  }
  if (!response.ok) throw new Error(detailMessage(data, `Request failed (${response.status})`));
  return data;
};

export const Provider = ({ children }: any) => {
  const [state, setState] = React.useState<ContextDataType>({
    ...sharedInitState,
    userInfo: { ...init_userInfo, f: { ...init_userInfo.f }, s: { ...init_userInfo.s } },
  });
  const stateRef = useRef(state);
  const [msgData, setMsgData] = React.useState<MsgUserType[]>([]);
  const [msgTab, setMsgTab] = React.useState(false);
  const [msgReceived, setMsgReceived] = React.useState(false);
  const [errorBackend, setErrorBackend] = React.useState(false);
  const [fLoading, setFLoading] = React.useState(false);
  const [sLoading, setSLoading] = React.useState(false);
  const [currentTarget, setCurrentTarget] = React.useState(1);
  const [bettedUsers, setBettedUsers] = React.useState<BettedUserType[]>([]);
  const [previousHand, setPreviousHand] = React.useState<UserType[]>([]);
  const [history, setHistory] = React.useState<number[]>([]);
  const [latestRoundNumber, setLatestRoundNumber] = React.useState(0);
  const [gameState, setGameState] = React.useState({
    currentNum: "1",
    currentSecondNum: 0,
    GameState: "",
    time: 0,
  });
  const [userBetState, setUserBetState] = React.useState<UserStatusType>({
    fbetState: false,
    fbetted: false,
    fcancellable: false,
    sbetState: false,
    sbetted: false,
    scancellable: false,
  });
  const [betLimit, setBetLimit] = React.useState<GameBetLimit>({ maxBet: 1000, minBet: 1 });
  const settledHistory = useRef<GameHistory[]>([]);
  const latestServerState = useRef<any>(null);
  const lastRound = useRef<number | null>(null);
  const requestInFlight = useRef<Record<PanelKey, boolean>>({ f: false, s: false });
  const pollInFlight = useRef(false);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const update = useCallback((attrs: Partial<ContextDataType>) => {
    setState((previous) => ({ ...previous, ...attrs }));
  }, []);

  const updateUserBetState = useCallback((attrs: Partial<UserStatusType>) => {
    setUserBetState((previous) => ({ ...previous, ...attrs }));
  }, []);

  const publishBalance = useCallback((balance: number) => {
    window.parent.postMessage(
      { source: "chakri-aviator", type: "balance", balance },
      window.location.origin,
    );
  }, []);

  const getMyBets = useCallback(async () => {
    try {
      const data = await fetchApi("/games/aviator/history");
      settledHistory.current = (data.rounds || []).map((round: any, index: number) => ({
        _id: round.round_number || round.id || index,
        name: "You",
        betAmount: Number(round.bet || 0),
        cashOut: Number(round.payout || 0),
        cashoutAt: Number(round.outcome?.multiplier || 0),
        cashouted: Number(round.payout || 0) > 0,
        createdAt: round.created_at || new Date().toISOString(),
        flyAway: Number(round.outcome?.crash_point || 0),
        flyDetailID: Number(round.round_number || 0),
        proofAvailable: Boolean(round.proof_available),
      }));
      setState((previous) => ({
        ...previous,
        myBets: [
          ...previous.myBets.filter((bet) => bet.active),
          ...settledHistory.current,
        ],
      }));
    } catch (error) {
      console.error("Unable to load Aviator bet history", error);
    }
  }, []);

  const applyServerState = useCallback((data: any) => {
    latestServerState.current = data;
    setErrorBackend(false);
    const phase = data.phase === "BETTING" ? "BET" : data.phase === "FLYING" ? "PLAYING" : "GAMEEND";
    const crashPoint = Number(data.crash_point || data.multiplier || 1);
    const elapsed = data.phase === "BETTING"
      ? Math.max(0, Number(data.betting_seconds || 5) - Number(data.phase_ends_in || 0))
      : data.phase === "FLYING"
        ? Number(data.fly_elapsed || 0)
        : Number(data.flight_seconds ?? flightTimeFor(crashPoint));
    setGameState({
      currentNum: crashPoint.toFixed(2),
      currentSecondNum: elapsed,
      GameState: phase,
      time: Math.round(elapsed * 1000),
    });
    if (data.phase !== "BETTING") setCurrentTarget(crashPoint);
    setHistory((data.history || []).map((round: any) => Number(round.crash_point)));
    setLatestRoundNumber(Number(data.round_number || 0));

    const feed = (data.all_bets || []).map((bet: any, index: number) => ({
      name: bet.name || "Player",
      betAmount: Number(bet.amount || 0),
      cashOut: Number(bet.payout || 0),
      cashouted: bet.status === "CASHED",
      target: Number(bet.multiplier || 0),
      img: avatarFor(bet.name || "Player", index),
    }));
    setBettedUsers(feed);
    setPreviousHand((data.previous_bets || []).map((bet: any, index: number) => ({
      ...init_userInfo,
      name: bet.name || "Player",
      betAmount: Number(bet.amount || 0),
      cashOut: Number(bet.payout || 0),
      cashouted: bet.status === "CASHED",
      target: Number(bet.multiplier || 0),
      img: avatarFor(bet.name || "Player", index + 41),
    })) as any);

    const open = (data.my_bets || []).filter((bet: any) => bet.status === "OPEN");
    const byPanel = (panel: number) => open.find((bet: any) => Number(bet.panel) === panel);
    const fBet = byPanel(1);
    const sBet = byPanel(2);
    setUserBetState((previous) => ({
      ...previous,
      fbetted: Boolean(fBet),
      fcancellable: Boolean(fBet) && (Boolean(fBet.queued) || data.phase === "BETTING"),
      sbetted: Boolean(sBet),
      scancellable: Boolean(sBet) && (Boolean(sBet.queued) || data.phase === "BETTING"),
    }));

    const activeHistory: GameHistory[] = open.map((bet: any) => ({
      _id: bet.id,
      name: "You",
      betAmount: Number(bet.amount || 0),
      cashOut: 0,
      cashoutAt: 0,
      cashouted: false,
      createdAt: bet.created_at || new Date().toISOString(),
      flyAway: 0,
      flyDetailID: Number(bet.round_number || data.round_number),
      active: true,
      proofAvailable: Boolean(bet.proof_available),
    }));
    const crashByRound = new Map<number, number>(
      (data.history || []).map((round: any) => [Number(round.round_number), Number(round.crash_point)]),
    );
    const recentSettled: GameHistory[] = (data.my_bets || [])
      .filter((bet: any) => bet.status === "CASHED" || bet.status === "LOST")
      .map((bet: any) => ({
        _id: bet.id,
        name: "You",
        betAmount: Number(bet.amount || 0),
        cashOut: Number(bet.payout || 0),
        cashoutAt: Number(bet.multiplier || 0),
        cashouted: bet.status === "CASHED",
        createdAt: bet.created_at || new Date().toISOString(),
        flyAway: crashByRound.get(Number(bet.round_number)) || 0,
        flyDetailID: Number(bet.round_number || 0),
        proofAvailable: Boolean(bet.proof_available),
      }));
    const recentSettledRounds = new Set(recentSettled.map((bet) => bet.flyDetailID));

    const balance = Number(data.balance || 0);
    setState((previous) => ({
      ...previous,
      seed: String(data.server_seed_hash || ""),
      myBets: [
        ...activeHistory,
        ...recentSettled,
        ...settledHistory.current.filter((bet) => !recentSettledRounds.has(bet.flyDetailID)),
      ],
      userInfo: {
        ...previous.userInfo,
        balance,
        currency: "CHIPS",
        f: { ...previous.userInfo.f, betid: fBet?.id || "0", betted: Boolean(fBet) },
        s: { ...previous.userInfo.s, betid: sBet?.id || "0", betted: Boolean(sBet) },
      },
    }));
    publishBalance(balance);

    const roundNumber = Number(data.round_number);
    if (lastRound.current !== null && roundNumber !== lastRound.current) {
      void getMyBets();
      const latest = stateRef.current;
      const settledPrevious = (data.my_bets || []).filter(
        (bet: any) => Number(bet.round_number) === lastRound.current && bet.status !== "OPEN",
      );
      const canRepeat = (panel: PanelKey, panelNumber: number) => {
        if (!latest.userInfo[panel].auto || Number(latest[`${panel}autoCound`]) <= 0) return false;
        const baseline = Number(latest[`${panel}autoStartBalance`]);
        const decreaseLimit = Number(latest[`${panel}decrease`]);
        const increaseLimit = Number(latest[`${panel}increase`]);
        const singleLimit = Number(latest[`${panel}singleAmount`]);
        const lastResult = settledPrevious.find((bet: any) => Number(bet.panel) === panelNumber);
        if (latest[`${panel}deState`] && decreaseLimit > 0 && baseline - balance >= decreaseLimit) return false;
        if (latest[`${panel}inState`] && increaseLimit > 0 && balance - baseline >= increaseLimit) return false;
        if (latest[`${panel}single`] && singleLimit > 0 && Number(lastResult?.payout || 0) >= singleLimit) return false;
        return true;
      };
      const fWasAuto = latest.userInfo.f.auto;
      const sWasAuto = latest.userInfo.s.auto;
      const fRepeats = canRepeat("f", 1);
      const sRepeats = canRepeat("s", 2);
      if ((latest.userInfo.f.auto && !fRepeats) || (latest.userInfo.s.auto && !sRepeats)) {
        setState((previous) => ({
          ...previous,
          fautoCound: fWasAuto && !fRepeats ? 0 : previous.fautoCound,
          sautoCound: sWasAuto && !sRepeats ? 0 : previous.sautoCound,
          userInfo: {
            ...previous.userInfo,
            f: { ...previous.userInfo.f, auto: fRepeats },
            s: { ...previous.userInfo.s, auto: sRepeats },
          },
        }));
      }
      setUserBetState((previous) => ({
        ...previous,
        fbetState: fWasAuto ? fRepeats : previous.fbetState,
        sbetState: sWasAuto ? sRepeats : previous.sbetState,
      }));
    }
    lastRound.current = roundNumber;

    if (Number.isFinite(data.min_bet) && Number.isFinite(data.max_bet)) {
      setBetLimit({ minBet: Number(data.min_bet), maxBet: Number(data.max_bet) });
    }
  }, [getMyBets, publishBalance]);

  const poll = useCallback(async () => {
    if (pollInFlight.current) return;
    pollInFlight.current = true;
    try {
      applyServerState(await fetchApi("/live/aviator/state"));
    } catch (error) {
      setErrorBackend(true);
      console.error("Aviator state sync failed", error);
    } finally {
      pollInFlight.current = false;
    }
  }, [applyServerState]);

  useEffect(() => {
    if (!window.localStorage.getItem("fg_token")) {
      window.parent.location.assign("/login");
      return undefined;
    }
    void getMyBets();
    void poll();
    const timer = window.setInterval(() => void poll(), 400);
    return () => window.clearInterval(timer);
  }, [getMyBets, poll]);

  const placePanelBet = useCallback(async (panel: PanelKey) => {
    if (requestInFlight.current[panel]) return;
    const snapshot = stateRef.current;
    const number = panel === "f" ? 1 : 2;
    const amount = Number(snapshot.userInfo[panel].betAmount);
    const autoCashout = panel === "f"
      ? snapshot.fautoCashoutState ? snapshot.fautoCashoutTarget : undefined
      : snapshot.sautoCashoutState ? snapshot.sautoCashoutTarget : undefined;
    if (!Number.isFinite(amount) || !Number.isInteger(amount)) {
      toast.error("Aviator stakes must use whole chips");
      updateUserBetState({ [`${panel}betState`]: false } as any);
      return;
    }
    if (amount < betLimit.minBet) {
      toast.error(`Minimum bet is ${betLimit.minBet.toFixed(2)} chips`);
      updateUserBetState({ [`${panel}betState`]: false } as any);
      return;
    }
    requestInFlight.current[panel] = true;
    panel === "f" ? setFLoading(true) : setSLoading(true);
    try {
      const response = await fetchApi("/live/aviator/bets", {
        method: "POST",
        body: JSON.stringify({ amount, panel: number, auto_cashout: autoCashout }),
      });
      setState((previous) => ({
        ...previous,
        [`${panel}autoCound`]: previous.userInfo[panel].auto
          ? Math.max(0, Number(previous[`${panel}autoCound`] || 0) - 1)
          : previous[`${panel}autoCound`],
        userInfo: {
          ...previous.userInfo,
          balance: Number(response.balance),
          [panel]: { ...previous.userInfo[panel], betid: response.bet_id, betted: true },
        },
      } as ContextDataType));
      updateUserBetState({
        [`${panel}betState`]: false,
        [`${panel}betted`]: true,
        [`${panel}cancellable`]: true,
      } as any);
      publishBalance(Number(response.balance));
      void poll();
    } catch (error: any) {
      toast.error(error?.message || "Unable to place bet");
      updateUserBetState({
        [`${panel}betState`]: false,
        [`${panel}betted`]: false,
        [`${panel}cancellable`]: false,
      } as any);
      setState((previous) => ({
        ...previous,
        [`${panel}autoCound`]: 0,
        userInfo: {
          ...previous.userInfo,
          [panel]: { ...previous.userInfo[panel], auto: false, betted: false, betid: "0" },
        },
      } as ContextDataType));
    } finally {
      requestInFlight.current[panel] = false;
      panel === "f" ? setFLoading(false) : setSLoading(false);
    }
  }, [betLimit.minBet, poll, publishBalance, updateUserBetState]);

  useEffect(() => {
    if (gameState.GameState !== "BET") return;
    if (userBetState.fbetState && !userBetState.fbetted) void placePanelBet("f");
    if (userBetState.sbetState && !userBetState.sbetted) void placePanelBet("s");
  }, [gameState.GameState, userBetState.fbetState, userBetState.sbetState, userBetState.fbetted, userBetState.sbetted, placePanelBet]);

  useEffect(() => {
    cancelBetImplementation = async (panel: PanelKey) => {
      if (requestInFlight.current[panel]) return;
      const betId = stateRef.current.userInfo[panel].betid;
      if (!betId || betId === "0") return;
      requestInFlight.current[panel] = true;
      panel === "f" ? setFLoading(true) : setSLoading(true);
      try {
        const response = await fetchApi("/live/aviator/bets/cancel", {
          method: "POST",
          body: JSON.stringify({ bet_id: betId }),
        });
        setUserBetState((previous) => ({
          ...previous,
          [`${panel}betState`]: false,
          [`${panel}betted`]: false,
          [`${panel}cancellable`]: false,
        }));
        setState((previous) => ({
          ...previous,
          [`${panel}autoCound`]: 0,
          userInfo: {
            ...previous.userInfo,
            balance: Number(response.balance),
            [panel]: {
              ...previous.userInfo[panel],
              auto: false,
              betted: false,
              betid: "0",
            },
          },
        } as ContextDataType));
        publishBalance(Number(response.balance));
        toast.info("Bet cancelled");
        void poll();
      } catch (error: any) {
        toast.error(error?.message || "Bet could not be cancelled");
        void poll();
      } finally {
        requestInFlight.current[panel] = false;
        panel === "f" ? setFLoading(false) : setSLoading(false);
      }
    };
    cashOutImplementation = async (_at: number, panel: PanelKey) => {
      const betId = stateRef.current.userInfo[panel].betid;
      if (!betId || betId === "0") return;
      try {
        const response = await fetchApi("/live/aviator/cashout", {
          method: "POST",
          body: JSON.stringify({ bet_id: betId }),
        });
        if (response.result === "cashed_out") {
          playGameSound("cashout");
          toast.success(`Cashed out at ${Number(response.multiplier).toFixed(2)}x`);
        }
        setUserBetState((previous) => ({ ...previous, [`${panel}betted`]: false }));
        setState((previous) => ({
          ...previous,
          userInfo: {
            ...previous.userInfo,
            balance: Number(response.balance),
            [panel]: { ...previous.userInfo[panel], betted: false, betid: "0" },
          },
        }));
        publishBalance(Number(response.balance));
        void getMyBets();
        void poll();
      } catch (error: any) {
        toast.error(error?.message || "Cash out was not accepted");
        void poll();
      }
    };
    return () => {
      cancelBetImplementation = () => undefined;
      cashOutImplementation = () => undefined;
    };
  }, [getMyBets, poll, publishBalance]);

  const handleGetSeedOfRound = useCallback(async (round: number): Promise<SeedDetailsType> => {
    try {
      return await fetchApi(`/live/aviator/rounds/${round}/fairness`);
    } catch (error) {
      console.error("Unable to load round proof", error);
      return {
        createdAt: new Date().toISOString(), serverSeed: "", serverSeedHash: "",
        resultHash: "", seedOfUsers: [], flyDetailID: round, crashPoint: 0, target: 0,
        verificationFactor: 0,
      };
    }
  }, []);

  const socket = useMemo(() => ({ emit: () => undefined }), []);
  const updateUserInfo = (attrs: Partial<UserType>) => {
    setState((previous) => ({ ...previous, userInfo: { ...previous.userInfo, ...attrs } }));
  };

  return (
    <Context.Provider value={{
      ...state,
      ...gameState,
      ...userBetState,
      ...betLimit,
      userInfo: state.userInfo,
      state,
      socket: socket as any,
      msgData,
      msgTab,
      msgReceived,
      setMsgReceived,
      platformLoading: false,
      errorBackend,
      globalUserInfo: state.userInfo,
      bettedUsers,
      previousHand,
      history,
      latestRoundNumber,
      rechargeState: false,
      secure: true,
      userSeedText: "",
      currentTarget,
      fLoading,
      setFLoading,
      sLoading,
      setSLoading,
      setCurrentTarget,
      update,
      updateUserInfo,
      getMyBets,
      updateUserBetState,
      setMsgData,
      handleGetSeed: () => undefined,
      handleGetSeedOfRound,
      handlePlaceBet: () => undefined,
      toggleMsgTab: () => setMsgTab((value) => !value),
      handleChangeUserSeed: () => undefined,
    }}>
      {children}
    </Context.Provider>
  );
};

export default Context;
