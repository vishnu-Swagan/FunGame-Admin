import { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { PageTransition } from "@/components/common";
import { Skeleton } from "@/components/ui/skeleton";
import { GameIntro } from "@/components/play/GameIntro";

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
import AviatorGame from "@/pages/play/AviatorGame";
import CheckerGame from "@/pages/play/CheckerGame";
import IceFishingGame from "@/pages/play/IceFishingGame";
import BlackjackGame from "@/pages/play/BlackjackGame";

const COMPONENTS = {
  "seven-up-down": DiceGame,
  "fun-target": TargetGame,
  "fun-roulette": RouletteGame,
  keno: KenoGame,
  bingo: BingoGame,
  "super-golden-wheel": WheelGame,
  "teen-patti": CardDuelGame,
  poker: CardDuelGame,
  "no-hold": VideoPokerGame,
  "champion-poker": ChampionPokerGame,
  "andar-bahar": AndarBaharGame,
  "fever-joker-bonus": FeverJokerGame,
  "giant-jackpot": GiantJackpotGame,
  "joker-bonus": JokerBonusGame,
  "lucky-8-line": Lucky8LineGame,
  "triple-fun": TripleFun777Game,
  aviator: AviatorGame,
  checker: CheckerGame,
  "ice-fishing": IceFishingGame,
  blackjack: BlackjackGame,
};

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
      <GameIntro game={game} />
    </PageTransition>
  );
}
