import { act } from "react";
import { createRoot } from "react-dom/client";

import { CategoryLobby } from "./RummyPremiumLobby";


jest.mock("@/components/common", () => ({ formatChips: (value) => String(value ?? 0) }));

const categories = [
  { id: "LV1", displayName: "Beginner", entryChips: 100, pointsValue: 1, minChipBalance: 100, turnDurationSeconds: 30 },
  { id: "LV2", displayName: "Classic", entryChips: 500, pointsValue: 2, minChipBalance: 500, turnDurationSeconds: 30 },
  { id: "LV3", displayName: "Pro", entryChips: 1000, pointsValue: 5, minChipBalance: 1000, turnDurationSeconds: 28 },
  { id: "LV4", displayName: "Elite", entryChips: 2500, pointsValue: 10, minChipBalance: 2500, turnDurationSeconds: 25 },
  { id: "LV5", displayName: "Royal", entryChips: 5000, pointsValue: 20, minChipBalance: 5000, turnDurationSeconds: 22 },
];

beforeAll(() => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  document.body.innerHTML = "";
  jest.clearAllMocks();
});

async function renderLobby(props = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <CategoryLobby
        categories={categories}
        balance={1100}
        busy={false}
        loading={false}
        error={false}
        joinFailure={null}
        preview={false}
        onJoin={jest.fn()}
        onRetry={jest.fn()}
        onExit={jest.fn()}
        {...props}
      />,
    );
    await Promise.resolve();
  });
  return { container, root };
}

async function click(element) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
  });
}

test("renders an original thirteen-card fan and a five-level mosaic without the gameplay table", async () => {
  const { container, root } = await renderLobby();
  expect(container.querySelectorAll(".rpl-card-fan > i")).toHaveLength(13);
  expect(container.querySelectorAll(".rpl-level-card")).toHaveLength(5);
  expect(container.querySelectorAll(".rpl-level-card.is-featured")).toHaveLength(1);
  expect(container.querySelector(".rpl-level-card.is-featured")?.dataset.categoryId).toBe("LV3");
  expect(container.querySelector('img[src="/game-art/rummy/table-palace-v2.png"]')).toBeNull();
  expect(container.textContent).toContain("CHAKRI.CASINO");
  expect(container.textContent).toContain("Choose your royal table");
  act(() => root.unmount());
});

test("gates only paid Live entry and keeps every Practice table actionable", async () => {
  const onJoin = jest.fn();
  const { container, root } = await renderLobby({ onJoin });
  const cards = [...container.querySelectorAll(".rpl-level-card")];

  cards.forEach((card, index) => {
    const live = [...card.querySelectorAll("button")].find((button) => button.textContent === "JOIN LIVE");
    const practice = [...card.querySelectorAll("button")].find((button) => button.textContent === "PRACTICE TABLE");
    expect(live.disabled).toBe(index > 2);
    expect(practice.disabled).toBe(false);
  });

  await click([...cards[2].querySelectorAll("button")].find((button) => button.textContent === "JOIN LIVE"));
  await click([...cards[4].querySelectorAll("button")].find((button) => button.textContent === "PRACTICE TABLE"));
  expect(onJoin).toHaveBeenNthCalledWith(1, "LV3", "LIVE");
  expect(onJoin).toHaveBeenNthCalledWith(2, "LV5", "PRACTICE");
  act(() => root.unmount());
});

test("preview disables Live entry while keeping Practice available", async () => {
  const { container, root } = await renderLobby({ preview: true });
  const cards = [...container.querySelectorAll(".rpl-level-card")];
  cards.forEach((card) => {
    const live = [...card.querySelectorAll("button")].find((button) => button.textContent === "LIVE DISABLED");
    const practice = [...card.querySelectorAll("button")].find((button) => button.textContent === "PRACTICE TABLE");
    expect(live.disabled).toBe(true);
    expect(practice.disabled).toBe(false);
  });
  act(() => root.unmount());
});
