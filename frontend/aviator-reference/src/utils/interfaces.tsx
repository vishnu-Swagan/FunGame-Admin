export interface BettedUserType {
    name: string;
    betAmount: number;
    cashOut: number;
    cashouted: boolean;
    target: number;
    img: string;
}

export interface BetResults {
    members: number;
    betAmount: number;
    cashouted: number;
}

export interface UserType {
    balance: number;
    userType: boolean;
    avatar: string;
    userId: string;
    currency: string;
    userName: string;
    ipAddress: string;
    platform: string;
    token: string;
    Session_Token: string;
    isSoundEnable: boolean;
    isMusicEnable: boolean;
    msgVisible: boolean;
    f: {
        auto: boolean;
        autocashout: boolean;
        betid: string;
        betted: boolean;
        cashouted: boolean;
        betAmount: number;
        cashAmount: number;
        target: number;
    };
    s: {
        auto: boolean;
        autocashout: boolean;
        betid: string;
        betted: boolean;
        cashouted: boolean;
        betAmount: number;
        cashAmount: number;
        target: number;
    };
}

export interface PlayerType {
    auto: boolean;
    betted: boolean;
    cashouted: boolean;
    betAmount: number;
    cashAmount: number;
    target: number;
}

export interface GameStatusType {
    currentNum: string;
    currentSecondNum: number;
    GameState: string;
    time: number;
}

export interface GameBetLimit {
    maxBet: number;
    minBet: number;
}

export declare interface GameHistory {
    _id: number;
    name: string;
    betAmount: number;
    cashOut?: number;
    cashoutAt: number;
    cashouted: boolean;
    createdAt: string;
    flyAway: number;
    flyDetailID: number;
    active?: boolean;
    proofAvailable?: boolean;
}

export interface UserStatusType {
    fbetState: boolean;
    fbetted: boolean;
    fcancellable: boolean;
    sbetState: boolean;
    sbetted: boolean;
    scancellable: boolean;
}

export interface ContextDataType {
    myBets: GameHistory[];
    width: number;
    seed: string;
    fautoCashoutState: boolean;
    fautoCashoutTarget: number;
    fautoCound: number;
    fautoStartBalance: number;
    finState: boolean;
    fdeState: boolean;
    fsingle: boolean;
    fincrease: number;
    fdecrease: number;
    fsingleAmount: number;
    fdefaultBetAmount: number;
    sautoCashoutState: boolean;
    sautoCashoutTarget: number;
    sautoCound: number;
    sautoStartBalance: number;
    sincrease: number;
    sdecrease: number;
    ssingleAmount: number;
    sinState: boolean;
    sdeState: boolean;
    ssingle: boolean;
    sdefaultBetAmount: number;
    userInfo: UserType;
}

export interface LoadingType {
    fLoading: boolean;
    sLoading: boolean;
}

export interface ContextType extends GameBetLimit, UserStatusType, GameStatusType {
    state: ContextDataType;
    seed: string;
    userInfo: UserType;
    socket: { emit: (...args: any[]) => void };
    msgData: MsgUserType[];
    platformLoading: boolean;
    msgTab: boolean;
    errorBackend: boolean;
    globalUserInfo: UserType;
    bettedUsers: BettedUserType[];
    previousHand: UserType[];
    history: number[];
    latestRoundNumber: number;
    rechargeState: boolean;
    secure: boolean;
    msgReceived: boolean;
    userSeedText: string;
    currentTarget: number;
    fLoading: boolean;
    setFLoading(attrs: boolean): void;
    sLoading: boolean;
    setSLoading(attrs: boolean): void;
    setCurrentTarget(attrs: number): void;
    setMsgReceived(attrs: boolean): void;
    update(attrs: Partial<ContextDataType>): void;
    updateUserInfo(attrs: Partial<UserType>): void;
    getMyBets(): void;
    updateUserBetState(attrs: Partial<UserStatusType>): void;
    setMsgData(attrs: MsgUserType[]): void;
    handleGetSeed(): void;
    handleGetSeedOfRound(attrs: number): Promise<SeedDetailsType>;
    handlePlaceBet(): void;
    toggleMsgTab(): void;
    handleChangeUserSeed(attrs: string): void;
}

export interface MsgUserType {
    _id?: string;
    userId: string;
    userName: string;
    avatar: string;
    message: string;
    img: string;
    likes: number;
    likesIDs: string[];
    disLikes: number;
    disLikesIDs: string[];
}

export interface SeedDetailsType {
    createdAt: string;
    serverSeed: string;
    serverSeedHash?: string;
    resultHash?: string;
    seedOfUsers: Array<{
        seed: string;
        userId: string;
    }>;
    flyDetailID: number;
    crashPoint?: number;
    target?: number;
    verificationFactor?: number;
    verificationFactorText?: string;
    fairnessVersion?: number;
    commitmentPayload?: string;
    algorithm?: string;
}

export const init_state = {
    myBets: [],
    width: 1500,
    seed: "",
    fautoCashoutState: false,
    fautoCashoutTarget: 2,
    fautoCound: 0,
    fautoStartBalance: 0,
    finState: false,
    fdeState: false,
    fsingle: false,
    fincrease: 0,
    fdecrease: 0,
    fsingleAmount: 0,
    fdefaultBetAmount: 20,
    sautoCashoutState: false,
    sautoCashoutTarget: 2,
    sautoCound: 0,
    sautoStartBalance: 0,
    sincrease: 0,
    sdecrease: 0,
    ssingleAmount: 0,
    sinState: false,
    sdeState: false,
    ssingle: false,
    sdefaultBetAmount: 20,
    userInfo: {
        balance: 0,
        userType: false,
        userId: "",
        avatar: "",
        userName: "",
        ipAddress: "",
        platform: "desktop",
        token: '',
        Session_Token: '',
        currency: "CHIPS",
        isSoundEnable: false,
        isMusicEnable: false,
        msgVisible: false,
        f: {
            auto: false,
            autocashout: false,
            betid: '0',
            betted: false,
            cashouted: false,
            cashAmount: 0,
            betAmount: 20,
            target: 2,
        },
        s: {
            auto: false,
            autocashout: false,
            betid: '0',
            betted: false,
            cashouted: false,
            cashAmount: 0,
            betAmount: 20,
            target: 2,
        },
    }
} as ContextDataType;

export const init_userInfo = {
    balance: 0,
    userType: false,
    userId: "",
    avatar: "",
    userName: "",
    ipAddress: "",
    platform: "desktop",
    token: '',
    Session_Token: '',
    currency: "CHIPS",
    isSoundEnable: false,
    isMusicEnable: false,
    msgVisible: false,
    f: {
        auto: false,
        autocashout: false,
        betid: '0',
        betted: false,
        cashouted: false,
        cashAmount: 0,
        betAmount: 20,
        target: 2,
    },
    s: {
        auto: false,
        autocashout: false,
        betid: '0',
        betted: false,
        cashouted: false,
        cashAmount: 0,
        betAmount: 20,
        target: 2,
    },
}
