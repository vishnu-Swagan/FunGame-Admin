import React, { useEffect } from "react";
import MoonLoader from "react-spinners/MoonLoader";
import "./bets.scss";
import { authHeaders, config, gameAssetUrl } from "../../config";
import Context from "../../context";

interface TopBet {
  betAmount: number;
  cashOut?: number;
  cashoutAt: number;
  userinfo?: Array<{
    avatar?: string;
    userName?: string;
  }>;
}

const PERIODS = ["day", "month", "year"] as const;

const TopHistory = () => {
  const { latestRoundNumber } = React.useContext(Context);
  const [type, setType] = React.useState(0);
  const [history, setHistory] = React.useState<TopBet[]>([]);
  const [loadingEffect, setLoadingEffect] = React.useState(false);
  const [loadError, setLoadError] = React.useState(false);

  const callDate = React.useCallback(async (date: string) => {
    try {
      setLoadingEffect(true);
      setLoadError(false);
      const response = await fetch(`${config.api}/live/aviator/top?period=${date}`, {
        headers: authHeaders(),
      });
      if (response.ok) {
        const data = await response.json();
        setHistory(Array.isArray(data.data) ? data.data : []);
      } else {
        setLoadError(true);
      }
    } catch (error) {
      setLoadError(true);
    } finally {
      setLoadingEffect(false);
    }
  }, []);

  useEffect(() => {
    callDate(PERIODS[type]);
  }, [callDate, type, latestRoundNumber]);

  const selectPeriod = (nextType: number) => {
    setType(nextType);
  };

  return (
    <>
      <div className="navigation-switcher-wrapper">
        <div className="navigation-switcher" role="tablist" aria-label="Top bets period">
          <div
            className="slider"
            style={{ transform: `translate(${100 * type}px)` }}
            aria-hidden="true"
          />
          <button
            type="button"
            role="tab"
            aria-selected={type === 0}
            onClick={() => selectPeriod(0)}
            className={`tab ${type === 0 ? "active" : ""}`}
          >
            Day
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={type === 1}
            onClick={() => selectPeriod(1)}
            className={`tab ${type === 1 ? "active" : ""}`}
          >
            Month
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={type === 2}
            onClick={() => selectPeriod(2)}
            className={`tab ${type === 2 ? "active" : ""}`}
          >
            Year
          </button>
        </div>
      </div>
      <div className="top-list-wrapper">
        <div className="top-items-list scroll-y h-100">
          {loadingEffect ? (
            <div className="top-list-state" role="status" aria-label="Loading top bets">
              <MoonLoader
                color="#b8f41b"
                size={35}
                data-testid="loader"
              />
            </div>
          ) : loadError ? (
            <div className="bets-empty" role="alert">
              <span className="bets-empty__mark is-error" aria-hidden="true" />
              <strong>Top bets unavailable</strong>
              <button type="button" className="retry-button" onClick={() => callDate(PERIODS[type])}>
                Try again
              </button>
            </div>
          ) : history.length === 0 ? (
            <div className="bets-empty" role="status">
              <span className="bets-empty__mark" aria-hidden="true" />
              <strong>No settled bets yet</strong>
              <span>Winning rounds will appear here.</span>
            </div>
          ) : (
            <>
              {history.map((item: any, index: number) => (
                <div key={index} className="bet-item">
                  <div className="main">
                    <div className="icon">
                      <img
                        className="avatar"
                        alt=""
                        src={item.userinfo?.[0]?.avatar || gameAssetUrl("avatars/av-5.png")}
                      />
                      <div className="username">{maskName(item.userinfo?.[0]?.userName)}</div>
                    </div>
                    <div className="score">
                      <div className="flex">
                        <div className="">
                          <span>Bet, chips:&nbsp;</span>
                          <span></span>
                        </div>
                        <span className="amount">
                          {item.betAmount.toFixed(2)}
                        </span>
                      </div>
                      <div className="flex">
                        <div className="">
                          <span>Cashed out:&nbsp;</span>
                        </div>
                        <span className="amount cashout">
                          {item.cashoutAt.toFixed(2)}x
                        </span>
                      </div>
                      <div className="flex">
                        <div className="">
                          <span>Win, chips: &nbsp;</span>
                        </div>
                        <span className="amount">
                          {Number(item.cashOut ?? item.cashoutAt * item.betAmount).toFixed(2)}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </>
          )}
        </div>
      </div>
    </>
  );
};

const maskName = (name?: string) => {
  if (!name) return "Guest";
  if (name.length === 1) return `${name}***`;
  return `${name.slice(0, 1)}***${name.slice(-1)}`;
};

export default TopHistory;
