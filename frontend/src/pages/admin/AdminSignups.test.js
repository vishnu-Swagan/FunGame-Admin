import { act } from "react";
import { createRoot } from "react-dom/client";
import { toast } from "sonner";
import { api } from "@/lib/api";
import AdminSignups from "./AdminSignups";

jest.mock("sonner", () => ({ toast: { error: jest.fn(), success: jest.fn() } }));
jest.mock("@/lib/api", () => ({
  api: { post: jest.fn() },
  errMsg: (error) => error?.message || "Request failed",
}));

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function setInput(input, value) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

beforeAll(() => { global.IS_REACT_ACT_ENVIRONMENT = true; });
beforeEach(() => { jest.clearAllMocks(); });
afterEach(() => { document.body.innerHTML = ""; });

test("provisions an admin-created player with the requested promotional balance", async () => {
  api.post.mockResolvedValue({
    data: {
      message: "Account created. Login ID: GK7654321",
      username: "GK7654321",
      password: "ABCDEFG",
    },
  });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(<AdminSignups />); await settle(); });

  await act(async () => {
    setInput(container.querySelector('[data-testid="create-name-input"]'), "Chakri QA Demo");
    setInput(container.querySelector('[data-testid="create-chips-input"]'), "1000000");
    await settle();
  });
  await act(async () => {
    container.querySelector('[data-testid="create-user-button"]').click();
    await settle();
  });

  expect(api.post).toHaveBeenCalledWith("/admin/users", {
    full_name: "Chakri QA Demo",
    starting_chips: 1000000,
  });
  expect(container.querySelector('[data-testid="created-credentials"]')?.textContent).toContain("GK7654321");
  expect(container.querySelector('[data-testid="created-credentials"]')?.textContent).toContain("ABCDEFG");
  expect(toast.success).toHaveBeenCalledWith("Account created. Login ID: GK7654321");
  await act(async () => root.unmount());
});
