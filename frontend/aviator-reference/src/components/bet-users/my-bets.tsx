import React from "react";
// import { useCrashContext } from "../Main/context";
import Context from "../../context";
import { SeedModal } from "../Main/seedModal";

const MyBets = () => {
    const state = React.useContext(Context);
    const myBets = state?.state.myBets || [];
    const [proofRound, setProofRound] = React.useState<number | null>(null);

    return (
        <>
            <div className="legend">
                <div className="date">Date</div>
                <div className="bet-100">
                    <span className="bet">Bet, chips</span>
                    <span>X</span>
                    <span className="cash-out"> Cash out, chips </span>
                </div>
                <div className="tools"></div>
            </div>
            <div className="cdk-virtual-scroll-viewport">
                <div className="cdk-virtual-scroll-content-wrapper">
                    {myBets.length === 0 && (
                        <div className="bets-empty" role="status">
                            <span className="bets-empty__mark" aria-hidden="true" />
                            <strong>No bets yet</strong>
                            <span>Your settled and active bets will appear here.</span>
                        </div>
                    )}
                    {myBets.map((user, key) => (
                        <div className={`bet-item pr-2 ${user.cashouted ? "celebrated" : ""} ${user.active ? "is-active" : ""}`} key={key}>
                            <div className="user">
                                <div className="username" title={new Date(user.createdAt).toLocaleString("en-IN")}>{formatDateTime(user.createdAt)}</div>
                            </div>
                            <div className="bet">
                                {Number(user.betAmount).toFixed(2)}
                            </div>
                            {user.cashouted &&
                                <div className="multiplier-block">
                                    <div className="bubble">{Number(user.cashoutAt).toFixed(2)}</div>
                                </div>
                            }
                            {user.active && !user.cashouted &&
                                <div className="multiplier-block">
                                    <div className="bubble">LIVE</div>
                                </div>
                            }
                            <div className="cash-out">
                                {user.cashouted
                                    ? Number(user.cashOut ?? user.betAmount * user.cashoutAt).toFixed(2)
                                    : ""}
                            </div>
                            <div className="tools" aria-label="Round tools">
                                {user.proofAvailable && !user.active && Number(user.flyDetailID) > 0 && (
                                    Number(user.flyDetailID) < state.latestRoundNumber ||
                                    (Number(user.flyDetailID) === state.latestRoundNumber && state.GameState === "GAMEEND")
                                ) && (
                                    <button
                                        type="button"
                                        className="fairness-i"
                                        aria-label={`Verify round ${user.flyDetailID}`}
                                        title="Verify provably fair result"
                                        onClick={() => setProofRound(Number(user.flyDetailID))}
                                    />
                                )}
                            </div>
                        </div>
                    ))}
                </div>
            </div>
            {proofRound !== null && (
                <SeedModal
                    setModal={() => setProofRound(null)}
                    modalParam={{ modalState: true, flyDetailId: proofRound }}
                />
            )}
        </>
    )
}

const formatDateTime = (createdAt: string | number | Date) =>
    new Intl.DateTimeFormat("en-IN", {
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
    }).format(new Date(createdAt));

export default MyBets;
