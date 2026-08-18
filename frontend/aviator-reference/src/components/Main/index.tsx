import React from "react";
import "./main.scss";
import History from "./history";
import Crash from "../Crash/index";
import Bet from "./bet";

export default function Main() {
  const [addBetPanel, setAddBetPanel] = React.useState(true);
  return (
    <main className="game-play">
      <History />
      <section className="stage-board" aria-label="Live Aviator round">
        <div className="play-board-wrapper">
          <div className="stage-canvas">
            <Crash />
          </div>
        </div>
      </section>
      <section className="bet-controls" aria-label="Bet controls">
        <div className="controls">
          <Bet index={"f"} add={addBetPanel} setAdd={setAddBetPanel} />
          {addBetPanel &&
            <Bet index={"s"} add={addBetPanel} setAdd={setAddBetPanel} />
          }
        </div>
      </section>
    </main>
  );
}
