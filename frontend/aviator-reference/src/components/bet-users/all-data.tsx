import React from "react"
import Context from "../../context";
import { BettedUserType, UserType } from "../../utils/interfaces";
// import { useCrashContext } from "../Main/context";

interface AllDataProps {
    pre: boolean
    setPre: React.Dispatch<React.SetStateAction<boolean>>
    allData: UserType[] | BettedUserType[]
}

const AllData = ({ pre, setPre, allData }: AllDataProps) => {
    const state = React.useContext(Context)
    // const [state] = useCrashContext();

    return (
        <>
            <div className="all-bets-summary">
                <div className="all-bets-block">
                    <div>
                        <div className="all-bets-label">Round activity</div>
                        <div className="all-bets-total">
                            {pre ? previousLabel(allData.length) : `${state.bettedUsers?.length || 0} bets placed`}
                        </div>
                    </div>
                    <button
                        type="button"
                        className={`previous-hand ${pre ? "click" : ""}`}
                        aria-pressed={pre}
                        onClick={() => setPre(!pre)}
                    >
                        <span className="history-i" aria-hidden="true" />
                        <span>{pre ? "Current hand" : "Previous hand"}</span>
                    </button>
                </div>
                <div className="spacer"></div>
                <div className="legend">
                    <span className="user">User</span>
                    <span className="bet">Bet, chips</span>
                    <span>X</span>
                    <span className="cash-out">Cash out, chips</span>
                </div>
            </div>
            <div className="cdk-virtual-scroll-viewport">
                <div className="cdk-virtual-scroll-content-wrapper">
                    {allData.length === 0 && (
                        <div className="bets-empty" role="status">
                            <span className="bets-empty__mark" aria-hidden="true" />
                            <strong>{pre ? "No bets in the previous hand" : "Waiting for the first bet"}</strong>
                            <span>New bets will appear here in real time.</span>
                        </div>
                    )}
                    {allData?.map((user, key) => (
                        <div className={`bet-item ${user.cashouted ? "celebrated" : ""}`} key={key}>
                            <div className="user">
                                {user.img ?
                                    <img className="avatar" src={user.img} alt="" /> :
                                    <img className="avatar" src="./avatars/av-5.png" alt="" />
                                }
                                <div className="username">{maskName(user.name)}</div>
                            </div>
                            <div className="bet">
                                {Number(user.betAmount).toFixed(2)}
                            </div>
                            {user.cashouted &&
                                <div className="multiplier-block">
                                    <div className="bubble">{Number(user.target).toFixed(2)}</div>
                                </div>
                            }
                            <div className="cash-out">{Number(user.cashOut) > 0 ? Number(user.cashOut).toFixed(2) : ""}</div>
                        </div>
                    ))}
                </div>
            </div>
        </>
    )
};

const maskName = (name?: string) => {
    if (!name) return "Guest";
    if (name.length === 1) return `${name}***`;
    return `${name.slice(0, 1)}***${name.slice(-1)}`;
};

const previousLabel = (count: number) => `${count} ${count === 1 ? "bet" : "bets"} last hand`;

export default AllData;
