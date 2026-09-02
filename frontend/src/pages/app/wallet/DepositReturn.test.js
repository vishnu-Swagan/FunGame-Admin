import { act } from "react";
import { createRoot } from "react-dom/client";
import DepositReturn from "./DepositReturn";

const mockDeposit = jest.fn();
const mockMission = jest.fn();
const mockNavigate = jest.fn();
const mockRefreshUser = jest.fn();

jest.mock("react-router-dom", () => ({
  useNavigate: () => mockNavigate,
  useParams: () => ({ depositId: "deposit-1" }),
  useSearchParams: () => [new URLSearchParams()],
}), { virtual: true });
jest.mock("@/context/AuthContext", () => ({ useAuth: () => ({ refreshUser: mockRefreshUser }) }));
jest.mock("@/lib/paymentApi", () => ({ payments: { deposit: (...args) => mockDeposit(...args) } }));
jest.mock("@/lib/promotionApi", () => ({ promotions: { mission: (...args) => mockMission(...args) } }));
jest.mock("@/components/promotions", () => ({ MissionReceipt: ({ mission }) => <div data-testid="mission-receipt">{mission.id}</div> }));
jest.mock("@/components/common", () => ({ PageTransition: ({ children, ...props }) => <div {...props}>{children}</div> }));
jest.mock("@/pages/app/wallet/WalletBits", () => ({ PaymentStatus: ({ status }) => <span>{status}</span> }));
jest.mock("@/components/ui/button", () => ({ Button: ({ children, ...props }) => <button {...props}>{children}</button> }));

beforeAll(() => { global.IS_REACT_ACT_ENVIRONMENT = true; });
beforeEach(() => {
  mockDeposit.mockReset();
  mockMission.mockReset();
  mockNavigate.mockReset();
  mockRefreshUser.mockReset().mockResolvedValue(undefined);
});
afterEach(() => { document.body.innerHTML = ""; });

async function settle() { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); }

test("uses the server deposit mission id to load the full-screen receipt", async () => {
  mockDeposit.mockResolvedValue({ id: "deposit-1", status: "CREDITED", mission_id: "mission-1" });
  mockMission.mockResolvedValue({ mission: { id: "mission-1", status: "ACTIVE" }, events: [] });
  const container = document.createElement("div"); document.body.appendChild(container); const root = createRoot(container);
  await act(async () => { root.render(<DepositReturn />); await settle(); });
  expect(mockMission).toHaveBeenCalledWith("mission-1");
  expect(container.querySelector('[data-testid="mission-receipt"]').textContent).toBe("mission-1");
  expect(mockRefreshUser).toHaveBeenCalled();
  await act(async () => root.unmount());
});

test("never invents a mission for a credited deposit without a server mission reference", async () => {
  mockDeposit.mockResolvedValue({ id: "deposit-1", status: "CREDITED" });
  const container = document.createElement("div"); document.body.appendChild(container); const root = createRoot(container);
  await act(async () => { root.render(<DepositReturn />); await settle(); });
  expect(mockMission).not.toHaveBeenCalled();
  expect(container.querySelector('[data-testid="mission-receipt"]')).toBeNull();
  expect(container.textContent).toContain("Funds credited");
  await act(async () => root.unmount());
});
