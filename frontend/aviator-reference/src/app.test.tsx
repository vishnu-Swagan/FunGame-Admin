import React from "react";
import { render, screen } from "@testing-library/react";
import App from "./app";
import Context from "./context";

jest.mock("./components/header", () => () => <div data-testid="header" />);
jest.mock("./components/bet-users", () => () => <div data-testid="bets" />);
jest.mock("./components/Main", () => () => <div data-testid="game" />);

test("insufficient balance stays on the player deposit flow", () => {
  render(
    <Context.Provider value={{ rechargeState: true, errorBackend: false } as any}>
      <App />
    </Context.Provider>,
  );

  const link = screen.getByRole("link", { name: "Request chips" });
  expect(link.getAttribute("href")).toBe("/chips/deposit");
  expect(link.getAttribute("target")).toBe("_top");
});
