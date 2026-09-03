import { act } from "react";
import { createRoot } from "react-dom/client";
import { useAuth } from "@/context/AuthContext";
import CasinoEntry from "./CasinoEntry";

jest.mock("@/context/AuthContext", () => ({ useAuth: jest.fn() }));
jest.mock("react-router-dom", () => ({
  Navigate: ({ to }) => <span data-navigate-to={to}>{to}</span>,
}), { virtual: true });

beforeAll(() => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
});

async function renderEntry() {
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => {
    root.render(<CasinoEntry />);
  });
  return { container, root };
}

test("guests hitting /casino open the unified login page", async () => {
  useAuth.mockReturnValue({ user: null, loading: false });
  const { container, root } = await renderEntry();
  expect(container.querySelector("[data-navigate-to]")?.getAttribute("data-navigate-to")).toBe("/?auth=login");
  await act(async () => root.unmount());
});

test("ACTIVE players hitting /casino open the lobby games picker", async () => {
  useAuth.mockReturnValue({ user: { role: "PLAYER", status: "ACTIVE" }, loading: false });
  const { container, root } = await renderEntry();
  expect(container.querySelector("[data-navigate-to]")?.getAttribute("data-navigate-to")).toBe("/?tab=games");
  await act(async () => root.unmount());
});
