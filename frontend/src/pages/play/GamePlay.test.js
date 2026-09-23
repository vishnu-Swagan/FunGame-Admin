import { act } from "react";
import { createRoot } from "react-dom/client";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import { RequireActive } from "@/components/RouteGuards";
import GamePlay from "./GamePlay";

let mockSlug;
const mockNavigate = jest.fn();
jest.mock("react-router-dom", () => ({
  useParams: () => ({ slug: mockSlug }),
  useNavigate: () => mockNavigate,
  useLocation: () => ({ pathname: `/games/${mockSlug}/play` }),
  Navigate: ({ to }) => <div data-redirect={to} />,
}), { virtual: true });
jest.mock("sonner", () => ({ toast: { info: jest.fn(), error: jest.fn() } }));
jest.mock("@/lib/api", () => ({
  api: { get: jest.fn() },
  errCode: (error) => error?.response?.data?.detail?.code,
  routeForUser: () => "/onboarding/pending",
}));
jest.mock("@/context/AuthContext", () => ({ useAuth: jest.fn() }));
jest.mock("@/components/common", () => ({
  PageTransition: ({ children }) => <main>{children}</main>,
  LoadingScreen: () => <div data-testid="auth-loading" />,
}));
jest.mock("@/components/ui/skeleton", () => ({ Skeleton: () => <div data-testid="skeleton" /> }));
jest.mock("@/components/play/GameIntro", () => ({ GameIntro: () => <div data-testid="intro" /> }));
jest.mock("@/components/play/LastWinnerRotator", () => ({ LastWinnerRotator: () => <div data-testid="winner" /> }));
jest.mock("@/pages/play/chicken-road/LiveChickenRoadGame", () => () => <div data-testid="live-chicken-road" />);
jest.mock("@/pages/play/DiceGame", () => () => null);
jest.mock("@/pages/play/TargetGame", () => () => null);
jest.mock("@/pages/play/RouletteGame", () => ({ game }) => <div data-testid="roulette">{game.name}</div>);
jest.mock("@/pages/play/KenoGame", () => () => null);
jest.mock("@/pages/play/BingoGame", () => () => null);
jest.mock("@/pages/play/WheelGame", () => () => null);
jest.mock("@/pages/play/CardDuelGame", () => () => null);
jest.mock("@/pages/play/VideoPokerGame", () => () => null);
jest.mock("@/pages/play/ChampionPokerGame", () => () => null);
jest.mock("@/pages/play/AndarBaharGame", () => () => null);
jest.mock("@/pages/play/SlotGame", () => () => null);
jest.mock("@/pages/play/slots/TripleFun777Game", () => () => null);
jest.mock("@/pages/play/slots/JokerBonusGame", () => () => null);
jest.mock("@/pages/play/slots/Lucky8LineGame", () => () => null);
jest.mock("@/pages/play/slots/GiantJackpotGame", () => () => null);
jest.mock("@/pages/play/slots/FeverJokerGame", () => () => null);
jest.mock("@/pages/play/CheckerGame", () => () => null);
jest.mock("@/pages/play/IceFishingGame", () => () => null);
jest.mock("@/pages/play/BlackjackGame", () => () => null);
jest.mock("@/pages/play/RummyGame", () => () => null);
jest.mock("@/pages/play/cabinet/SevenUpDownCabinet", () => () => null);
jest.mock("@/pages/play/cabinet/AndarBaharCabinet", () => () => null);
jest.mock("@/pages/play/cabinet/FunTargetCabinet", () => () => null);
jest.mock("@/pages/play/cabinet/KenoCabinet", () => () => null);
jest.mock("@/pages/play/cabinet/PappuPicturesCabinet", () => () => null);
jest.mock("@/pages/play/cabinet/CheckerCabinet", () => () => null);
jest.mock("@/pages/play/cabinet/FluidCabinets", () => ({ AviatorCabinet: () => null }));
jest.mock("@/pages/play/cabinet/stakeGames", () => ({
  NoHoldCabinet: () => null, ChampionPokerCabinet: () => null, FeverJokerCabinet: () => null,
  GiantJackpotCabinet: () => null, Lucky8LineCabinet: () => null, TripleFunCabinet: () => null,
  BingoCabinet: () => null, GoldenWheelCabinet: () => null,
}));

let container;
let root;
const originalActEnvironment = global.IS_REACT_ACT_ENVIRONMENT;
beforeAll(() => { global.IS_REACT_ACT_ENVIRONMENT = true; });
afterAll(() => { global.IS_REACT_ACT_ENVIRONMENT = originalActEnvironment; });
beforeEach(() => {
  jest.clearAllMocks();
  mockSlug = "chicken-road";
  useAuth.mockReturnValue({ user: { id: "player-1", role: "PLAYER", status: "ACTIVE" }, loading: false });
  api.get.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });
const renderRoute = async () => { await act(async () => { root.render(<RequireActive><GamePlay /></RequireActive>); }); };
const byId = (id) => container.querySelector(`[data-testid="${id}"]`);
const metadata = (status = "ENABLED") => ({ data: { game: { slug: "fun-roulette", name: "Roulette", status } } });
const deferred = () => { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

test("authenticated Chicken Road mounts its live recovery controller without catalogue metadata", async () => {
  await renderRoute();
  expect(byId("live-chicken-road")).not.toBeNull();
  expect(api.get).not.toHaveBeenCalled();
  expect(mockNavigate).not.toHaveBeenCalled();
  expect(byId("skeleton")).toBeNull();
  expect(byId("intro")).toBeNull();
  expect(byId("winner")).toBeNull();
});

test.each([null, { role: "PLAYER", status: "PENDING" }])("Chicken Road does not bypass the existing player authentication guard (%j)", async (user) => {
  useAuth.mockReturnValue({ user, loading: false });
  await renderRoute();
  expect(byId("live-chicken-road")).toBeNull();
  expect(container.querySelector("[data-redirect]")).not.toBeNull();
  expect(api.get).not.toHaveBeenCalled();
});

test.each(["MAINTENANCE", "COMING_SOON"])("other games remain blocked by %s catalogue metadata", async (status) => {
  mockSlug = "fun-roulette";
  api.get.mockResolvedValue(metadata(status));
  await renderRoute();
  expect(api.get).toHaveBeenCalledWith("/games/fun-roulette");
  expect(byId("roulette")).toBeNull();
  expect(byId("live-chicken-road")).toBeNull();
  expect(mockNavigate).toHaveBeenCalledWith("/games/fun-roulette", { replace: true });
  expect(toast.info).toHaveBeenCalledTimes(1);
});

test.each(["GAME_COMING_SOON", "COMING_SOON"])("other games retain the %s API rejection gate", async (code) => {
  mockSlug = "fun-roulette";
  api.get.mockRejectedValue({ response: { data: { detail: { code } } } });
  await renderRoute();
  expect(byId("roulette")).toBeNull();
  expect(mockNavigate).toHaveBeenCalledWith("/games/fun-roulette", { replace: true });
  expect(toast.info).toHaveBeenCalledWith("This game is coming soon.");
});

test("other games still wait for enabled metadata before mounting", async () => {
  mockSlug = "fun-roulette";
  const response = deferred();
  api.get.mockReturnValue(response.promise);
  await renderRoute();
  expect(byId("skeleton")).not.toBeNull();
  expect(byId("roulette")).toBeNull();
  await act(async () => { response.resolve(metadata()); });
  expect(byId("roulette").textContent).toBe("Roulette");
  expect(mockNavigate).not.toHaveBeenCalled();
});

test("other game metadata failures still return to the catalogue", async () => {
  mockSlug = "fun-roulette";
  api.get.mockRejectedValue(new Error("offline"));
  await renderRoute();
  expect(byId("roulette")).toBeNull();
  expect(mockNavigate).toHaveBeenCalledWith("/games", { replace: true });
  expect(toast.error).toHaveBeenCalledWith("Game could not be opened");
});

test("a stale previous-game failure cannot eject Chicken Road during recovery", async () => {
  mockSlug = "fun-roulette";
  const response = deferred();
  api.get.mockReturnValue(response.promise);
  await renderRoute();
  mockSlug = "chicken-road";
  await renderRoute();
  await act(async () => { response.reject({ response: { data: { detail: { code: "GAME_COMING_SOON" } } } }); });
  expect(byId("live-chicken-road")).not.toBeNull();
  expect(api.get).toHaveBeenCalledTimes(1);
  expect(mockNavigate).not.toHaveBeenCalled();
  expect(toast.info).not.toHaveBeenCalled();
});

test("leaving Chicken Road restores the normal catalogue gate", async () => {
  await renderRoute();
  mockSlug = "fun-roulette";
  api.get.mockResolvedValue(metadata("MAINTENANCE"));
  await renderRoute();
  expect(byId("live-chicken-road")).toBeNull();
  expect(byId("roulette")).toBeNull();
  expect(api.get).toHaveBeenCalledWith("/games/fun-roulette");
  expect(mockNavigate).toHaveBeenCalledWith("/games/fun-roulette", { replace: true });
});
