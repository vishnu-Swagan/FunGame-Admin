import { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { PageTransition } from "@/components/common";
import { Skeleton } from "@/components/ui/skeleton";
import { GameIntro } from "@/components/play/GameIntro";
import { LastWinnerRotator } from "@/components/play/LastWinnerRotator";

import DiceGame from "@/pages/play/DiceGame";
import TargetGame from "@/pages/play/TargetGame";
import RouletteGame from "@/pages/play/RouletteGame";
import KenoGame from "@/pages/play/KenoGame";
import BingoGame from "@/pages/play/BingoGame";
import WheelGame from "@/pages/play/WheelGame";
import CardDuelGame from "@/pages/play/CardDuelGame";
import VideoPokerGame from "@/pages/play/VideoPokerGame";
import ChampionPokerGame from "@/pages/play/ChampionPokerGame";
import AndarBaharGame from "@/pages/play/AndarBaharGame";
import SlotGame from "@/pages/play/SlotGame";
import TripleFun777Game from "@/pages/play/slots/TripleFun777Game";
import JokerBonusGame from "@/pages/play/slots/JokerBonusGame";
import Lucky8LineGame from "@/pages/play/slots/Lucky8LineGame";
import GiantJackpotGame from "@/pages/play/slots/GiantJackpotGame";
import FeverJokerGame from "@/pages/play/slots/FeverJokerGame";
import CheckerGame from "@/pages/play/CheckerGame";
import IceFishingGame from "@/pages/play/IceFishingGame";
import BlackjackGame from "@/pages/play/BlackjackGame";

/* The cabinet rebuild. Games move over one at a time so the live app keeps
   working through the rollout — a slug is either on the new landscape
   cabinet or still on its portrait table, never half of each. */
import SevenUpDownCabinet from "@/pages/play/cabinet/SevenUpDownCabinet";
import AndarBaharCabinet from "@/pages/play/cabinet/AndarBaharCabinet";
import FunTargetCabinet from "@/pages/play/cabinet/FunTargetCabinet";
import KenoCabinet from "@/pages/play/cabinet/KenoCabinet";
import CheckerCabinet from "@/pages/play/cabinet/CheckerCabinet";
import { AviatorCabinet } from "@/pages/play/cabinet/FluidCabinets";
import {
  NoHoldCabinet, ChampionPokerCabinet, FeverJokerCabinet, GiantJackpotCabinet,
  Lucky8LineCabinet, TripleFunCabinet, BingoCabinet, GoldenWheelCabinet,
} from "@/pages/play/cabinet/stakeGames";

const COMPONENTS = {
  "seven-up-down": SevenUpDownCabinet,
  "fun-target": FunTargetCabinet,
  "fun-roulette": RouletteGame,
  keno: KenoCabinet,
  bingo: BingoCabinet,
  "super-golden-wheel": GoldenWheelCabinet,
  "teen-patti": CardDuelGame,
  poker: CardDuelGame,
  "no-hold": NoHoldCabinet,
  "champion-poker": ChampionPokerCabinet,
  "andar-bahar": AndarBaharCabinet,
  "fever-joker-bonus": FeverJokerCabinet,
  "giant-jackpot": GiantJackpotCabinet,
  "joker-bonus": JokerBonusGame,
  "lucky-8-line": Lucky8LineCabinet,
  "triple-fun": TripleFunCabinet,
  aviator: AviatorCabinet,
  checker: CheckerCabinet,
  "ice-fishing": IceFishingGame,
  blackjack: BlackjackGame,
};

/* Slugs already rebuilt as landscape cabinets. */
const CABINET = new Set([
  "seven-up-down", "andar-bahar", "fun-target", "keno", "bingo", "checker",
  "fun-roulette", "aviator", "super-golden-wheel", "no-hold", "champion-poker",
  "fever-joker-bonus", "giant-jackpot", "lucky-8-line", "triple-fun",
]);

export default function GamePlay() {
  const { slug } = useParams();
  const navigate = useNavigate();
  const [game, setGame] = useState(null);

  useEffect(() => {
    let active = true;
    api
      .get(`/games/${slug}`)
      .then(({ data }) => {
        if (!active) return;
        if (data.game.status !== "ENABLED") {
          toast.info(`${data.game.name} is not playable right now (${data.game.status.replaceAll("_", " ").toLowerCase()}).`);
          navigate(`/games/${slug}`, { replace: true });
          return;
        }
        setGame(data.game);
      })
      .catch(() => {
        toast.error("Game not found");
        navigate("/games", { replace: true });
      });
    return () => {
      active = false;
    };
  }, [slug, navigate]);

  if (!game) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 rounded-xl bg-white/5" />
        <Skeleton className="h-[200px] rounded-2xl bg-white/5" />
        <Skeleton className="h-[140px] rounded-2xl bg-white/5" />
      </div>
    );
  }

  const Component = COMPONENTS[game.slug];
  if (!Component) {
    navigate(`/games/${slug}`, { replace: true });
    return null;
  }

  return (
    <PageTransition>
      {/* The live table mounts and starts polling immediately; the cinematic
          intro plays on top for ~4s, so it dissolves straight onto the round
          that is already in progress. */}
      <Component game={game} />
      <LastWinnerRotator slug={game.slug} />
      {/* The cabinet is its own fullscreen machine and opens straight onto the
          round in progress; the portrait tables keep the cinematic intro. */}
      {!CABINET.has(game.slug) && <GameIntro game={game} />}
    </PageTransition>
  );
}
