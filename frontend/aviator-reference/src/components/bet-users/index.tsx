import React from "react";
// import { useCrashContext } from "../Main/context";
// import { useEffect, useState } from "react";
import AllData from "./all-data";
import MyBets from "./my-bets";
import TopHistory from "./top-history";
import Context from "../../context";
import { BettedUserType, UserType } from "../../utils/interfaces";

export default function BetsUsers() {
  const { previousHand, bettedUsers, getMyBets, seed } = React.useContext(Context);

  const [headerType, setHeaderType] = React.useState("my");
  const [allData, setAllData] = React.useState<UserType[] | BettedUserType[]>(
    []
  );
  const [pre, setPre] = React.useState(false);

  const header = [
    { type: "all", value: "All Bets" },
    { type: "my", value: "My Bets", onClick: "myBet" },
    { type: "top", value: "Top" },
  ];

  const getData = (e: string) => {
    if (e === "myBet") getMyBets();
  };

  React.useEffect(() => {
    if (pre) {
      setAllData(previousHand);
    } else {
      setAllData(bettedUsers);
    }
  }, [pre, bettedUsers, previousHand]);

  return (
    <aside className="info-board" aria-label="Live betting activity">
      <section className="bets-block">
        <div className="bets-block__heading">
          <div>
            <span className="bets-block__eyebrow">Players</span>
            <h2>Live bets</h2>
          </div>
          <span className="live-count">
            <span aria-hidden="true" />
            {bettedUsers.length} active
          </span>
        </div>
        <div className="bet-block-nav">
          <div className="navigation-switcher" role="tablist" aria-label="Bet history">
              {header.map((item, index) => (
                <button
                  key={index}
                  type="button"
                  role="tab"
                  id={`bets-tab-${item.type}`}
                  aria-selected={headerType === item.type}
                  aria-controls={`bets-panel-${item.type}`}
                  className={`tab ${headerType === item.type ? "click" : ""}`}
                  onClick={() => {
                    setHeaderType(item.type);
                    item.onClick && getData(item.onClick);
                  }}
                >
                  {item.value}
                </button>
              ))}
          </div>
        </div>
        <div
          className="data-list"
          role="tabpanel"
          id={`bets-panel-${headerType}`}
          aria-labelledby={`bets-tab-${headerType}`}
        >
          {headerType === "all" ? (
            <AllData setPre={setPre} pre={pre} allData={allData} />
          ) : headerType === "my" ? (
            <MyBets />
          ) : (
            <TopHistory />
          )}
        </div>
        <footer className="bets-block__footer">
          <span className="fair-mark" aria-hidden="true" />
          <span>Provably fair rounds</span>
          <code className="round-commitment" title={seed || "Waiting for round commitment"}>
            {seed ? `${seed.slice(0, 10)}…` : "committing…"}
          </code>
        </footer>
      </section>
    </aside>
  );
}
