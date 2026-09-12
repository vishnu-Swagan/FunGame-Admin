import { act } from "react";
import { createRoot } from "react-dom/client";
import {
  NewPlayerOffersPopup,
  NewPlayerOffersSpotlight,
  OFFER_POPUP_SESSION_KEYS,
} from "./NewPlayerOffers";

const mockNavigate = jest.fn();

jest.mock("react-router-dom", () => ({
  useNavigate: () => mockNavigate,
}), { virtual: true });

beforeAll(() => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  window.sessionStorage.clear();
  mockNavigate.mockClear();
});

async function renderComponent(component) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(component);
  });
  return {
    container,
    root,
    async cleanup() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

test("website spotlight explains all new offers and routes visitors to signup", async () => {
  const view = await renderComponent(<NewPlayerOffersSpotlight />);

  expect(view.container.textContent).toContain("1,000");
  expect(view.container.textContent).toContain("100% first deposit bonus");
  expect(view.container.textContent).toContain("10% + 5% referrals");
  expect(view.container.textContent).toContain("Maximum withdrawal requests: ₹500 per day");

  await act(async () => {
    view.container.querySelector('[data-testid="offers-signup-cta"]').click();
  });
  expect(mockNavigate).toHaveBeenCalledWith("/register");
  await view.cleanup();
});

test("lobby spotlight routes players to the deposit and referral destinations", async () => {
  const view = await renderComponent(<NewPlayerOffersSpotlight signedIn />);

  await act(async () => {
    view.container.querySelector('[data-testid="offers-deposit-cta"]').click();
    view.container.querySelector('[data-testid="offers-referral-cta"]').click();
  });
  expect(mockNavigate).toHaveBeenNthCalledWith(1, "/wallet/deposit");
  expect(mockNavigate).toHaveBeenNthCalledWith(2, "/referral-rewards");
  await view.cleanup();
});

test("offer popup appears once per surface in a browser session and its CTA redirects", async () => {
  const first = await renderComponent(<NewPlayerOffersPopup />);
  expect(document.body.querySelector('[data-testid="website-offers-popup"]')).not.toBeNull();
  expect(document.documentElement.dataset.chakriOffersSurface).toBe("true");

  await act(async () => {
    document.body.querySelector('[data-testid="offers-signup-cta"]').click();
  });
  expect(mockNavigate).toHaveBeenCalledWith("/register");
  expect(window.sessionStorage.getItem(OFFER_POPUP_SESSION_KEYS.website)).toBe("seen");
  await first.cleanup();
  expect(document.documentElement.dataset.chakriOffersSurface).toBeUndefined();

  const second = await renderComponent(<NewPlayerOffersPopup />);
  expect(document.body.querySelector('[data-testid="website-offers-popup"]')).toBeNull();
  await second.cleanup();
});

test("lobby popup waits until competing promotion messaging is finished", async () => {
  const view = await renderComponent(<NewPlayerOffersPopup signedIn surface="lobby" enabled={false} />);
  expect(document.body.querySelector('[data-testid="lobby-offers-popup"]')).toBeNull();

  await act(async () => {
    view.root.render(<NewPlayerOffersPopup signedIn surface="lobby" enabled />);
  });
  expect(document.body.querySelector('[data-testid="lobby-offers-popup"]')).not.toBeNull();
  await view.cleanup();
});
