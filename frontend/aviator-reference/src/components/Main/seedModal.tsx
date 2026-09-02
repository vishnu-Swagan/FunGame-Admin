import React, { useCallback, useEffect, useState } from "react"
import CryptoJS from 'crypto-js';
import Context from "../../context";
import { Oval } from "react-loader-spinner";

export const SeedModal = ({ setModal, modalParam }: any) => {
    const { handleGetSeedOfRound } = React.useContext(Context);
    const [date, setDate] = useState('');
    const [loading, setLoading] = useState(false);
    const [resultHash, setResultHash] = useState<string>('');
    const [commitmentVerified, setCommitmentVerified] = useState(false);
    const [resultVerified, setResultVerified] = useState(false);
    const [seedDetails, setSeedDetails] = useState<any>();

    const getSeedDetails = useCallback(async () => {
        setLoading(true);
        const data = await handleGetSeedOfRound(modalParam.flyDetailId);
        setLoading(false);
        setSeedDetails(data);
        const newDate = new Date(data.createdAt);
        const localTime = newDate.toLocaleTimeString([], { hour12: false });
        setDate(localTime);

        const fairnessVersion = Number(data.fairnessVersion || 1);
        const verificationFactorText = data.verificationFactorText
            || Number(data.verificationFactor || 0).toFixed(12);
        const commitmentPayload = fairnessVersion >= 2
            ? `aviator-commit-v2:${verificationFactorText}:${data.serverSeed}`
            : data.serverSeed;
        const commitment = CryptoJS.SHA256(commitmentPayload).toString(CryptoJS.enc.Hex);
        const computedResultHash = CryptoJS.SHA256(`aviator-crash-v1:${data.serverSeed}`).toString(CryptoJS.enc.Hex);
        setCommitmentVerified(commitment === data.serverSeedHash);
        setResultHash(computedResultHash);
        const uniform = parseInt(computedResultHash.slice(0, 13), 16) / (2 ** 52);
        const rawCrash = Math.max(1, Number(data.verificationFactor || 0) / Math.max(1e-9, 1 - uniform));
        const derivedCrash = Math.min(1_000_000, Math.floor(rawCrash * 100) / 100);
        setResultVerified(
            computedResultHash === data.resultHash
            && Math.abs(derivedCrash - Number(data.crashPoint)) < 0.0001
        );
    }, [handleGetSeedOfRound, modalParam.flyDetailId]);

    useEffect(() => {
        getSeedDetails();
    }, [getSeedDetails])
    return (
        <div className={`modal ${modalParam.modalState && 'active'}`}>
            <button type="button" className="back" aria-label="Close round verification" onClick={() => setModal({ modalState: false, flyDetailId: '' })} />
            <div className="modal-dialog">
                <div className="modal-content">
                    <div className="modal-header">
                        <span className="modal-title">ROUND </span>
                        {seedDetails &&
                            <div className="header__info">
                                <div className={`bubble-multiplier ${Number(seedDetails?.target) < 2 ? "blue" : Number(seedDetails?.target) < 10 ? "purple" : "big"}`}>{Number(seedDetails?.target).toFixed(2)}x</div>

                                <div className="seed-time">{date}</div>
                            </div>
                        }
                        <button className="close" onClick={() => setModal({ modalState: false, flyDetailId: '' })}>
                            <span>x</span>
                        </button>
                    </div>
                    <div className="modal-body">
                        <div className="content-wrapper">
                            {loading ? <div className="content-loading">
                                <Oval
                                    height={35}
                                    width={35}
                                    color="red"
                                    wrapperClass=""
                                    visible={true}
                                    ariaLabel="oval-loading"
                                    secondaryColor="#990000"
                                    strokeWidth={3}
                                    strokeWidthSecondary={4}
                                />
                            </div> :
                                <div className="content">
                                    <div className="content-part">
                                        <div className="title">
                                            <div className="icon-server"></div>
                                            <div className="text">
                                                <span>Server Seed:</span>
                                                <div className="tip">Generated on our side</div>
                                            </div>
                                        </div>
                                        <div className="value">
                                            <input readOnly type="text" className="value-input" value={seedDetails?.serverSeed} />
                                        </div>
                                    </div>
                                    <div className="content-part pt-3">
                                        <div className="title">
                                            <div className="icon-client"></div>
                                            <div className="text">
                                                <span>Client Seed:</span>
                                                <div className="tip">Generated on players side</div>
                                            </div>
                                        </div>
                                        {seedDetails?.seedOfUsers?.map((user: any, key: number) => (
                                            <div className="client" key={key}>
                                                <div className="value">
                                                    <div className="player">
                                                        <span>Player N{key + 1}:</span>
                                                        <div className="user">
                                                            <img className="avatar" src={user.avatar} alt="" /> {user.userName.slice(0, 1) + '***' + user.userName.slice(-1)}
                                                        </div>
                                                    </div>
                                                    <div className="seed">
                                                        <span>Seed:</span>
                                                        <div className="seed-value">{`${user.seed}`}</div>
                                                    </div>
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                    <div className="content-part pt-3">
                                        <div className="title">
                                            <div className="icon-hash"></div>
                                            <div className="text">
                                                <span>Committed Seed Hash:</span>
                                                <div className="tip">The SHA256 commitment published before betting closed</div>
                                            </div>
                                        </div>
                                        <div className="value">
                                            <input readOnly type="text" className="value-input" value={seedDetails?.serverSeedHash || ''} />
                                        </div>
                                        <div className="tip">
                                            {commitmentVerified && resultVerified
                                                ? 'Commitment and crash result verified'
                                                : 'Round verification failed'}
                                        </div>
                                    </div>
                                    <div className="content-part pt-3">
                                        <div className="title">
                                            <div className="icon-hash"></div>
                                            <div className="text">
                                                <span>Round Result Hash:</span>
                                                <div className="tip">SHA256 of the revealed seed with the Aviator result domain</div>
                                            </div>
                                        </div>
                                        <div className="value">
                                            <input readOnly type="text" className="value-input" value={resultHash} />
                                        </div>
                                    </div>
                                    <div className="content-part pt-3 result">
                                        <div className="title">
                                            <span>Hex:</span>
                                            <span>Decimal:</span>
                                            <span>Result:</span>
                                            <span>Commitment:</span>
                                        </div>
                                        <div className="value">
                                            <span className="white">{resultHash?.slice(0, 13)}</span>
                                            <span className="white">{parseInt(resultHash.slice(0, 13) || '', 16)}</span>
                                            <span className="white">{Number(seedDetails?.target || 0).toFixed(2)}</span>
                                            <span className="white">v{Number(seedDetails?.fairnessVersion || 1)} · factor {seedDetails?.verificationFactorText || Number(seedDetails?.verificationFactor || 0).toFixed(12)}</span>
                                        </div>
                                    </div>
                                </div>
                            }
                        </div>
                    </div>
                </div>
            </div>
        </div>
    )
}
