import { act } from "react";
import { createRoot } from "react-dom/client";

import { api } from "@/lib/api";
import AdminStepUpDialog, { requiresAdminStepUp } from "./AdminStepUpDialog";

jest.mock("@/lib/api", () => ({
  api: { post: jest.fn() },
  errCode: (error) => error?.response?.data?.detail?.code || null,
  errMsg: (error) => error?.response?.data?.detail?.message || error?.message || "Request failed",
}));

jest.mock("sonner", () => ({
  toast: { error: jest.fn(), success: jest.fn() },
}));

beforeAll(() => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  api.post.mockReset();
});

const setInput = (input, value) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
};

test.each(["ADMIN_MFA_REQUIRED", "ADMIN_STEP_UP_REQUIRED"])(
  "%s opens the administrator verification ceremony",
  (code) => {
    expect(requiresAdminStepUp({ response: { data: { detail: { code } } } })).toBe(true);
  },
);

test("the dialog verifies password and one-time code before retrying the pending action", async () => {
  api.post
    .mockResolvedValueOnce({
      data: {
        challenge_id: "challenge-id-with-at-least-thirty-two-characters",
        destination_masked: "+91******3210",
        message: "Security code sent.",
      },
    })
    .mockResolvedValueOnce({ data: { message: "Administrator verification complete." } });
  const onVerified = jest.fn().mockResolvedValue(undefined);
  const onCancel = jest.fn();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(
      <AdminStepUpDialog
        open
        actionLabel="issuing distributor credentials"
        onCancel={onCancel}
        onVerified={onVerified}
      />,
    );
  });

  await act(async () => {
    setInput(container.querySelector("#admin-step-up-password"), "ADMIN-PASSWORD-12");
  });
  await act(async () => {
    container.querySelector('[data-testid="admin-step-up-password-form"]')
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });

  expect(api.post).toHaveBeenNthCalledWith(1, "/admin/security/step-up/start", {
    current_password: "ADMIN-PASSWORD-12",
  });
  expect(container.textContent).toContain("+91******3210");

  await act(async () => {
    setInput(container.querySelector("#admin-step-up-code"), "123456");
  });
  await act(async () => {
    container.querySelector('[data-testid="admin-step-up-code-form"]')
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });

  expect(api.post).toHaveBeenNthCalledWith(2, "/admin/security/step-up/verify", {
    challenge_id: "challenge-id-with-at-least-thirty-two-characters",
    code: "123456",
  });
  expect(onVerified).toHaveBeenCalledTimes(1);
  expect(onCancel).toHaveBeenCalledTimes(1);

  await act(async () => root.unmount());
  container.remove();
});

test("password-only step-up retries the pending KYC action without asking for a code", async () => {
  api.post.mockResolvedValueOnce({
    data: {
      verified: true,
      password_only: true,
      message: "Administrator password verified.",
    },
  });
  const onVerified = jest.fn().mockResolvedValue(undefined);
  const onCancel = jest.fn();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(
      <AdminStepUpDialog
        open
        actionLabel="completing this KYC decision"
        onCancel={onCancel}
        onVerified={onVerified}
      />,
    );
  });

  await act(async () => {
    setInput(container.querySelector("#admin-step-up-password"), "ADMIN-PASSWORD-12");
  });
  await act(async () => {
    container.querySelector('[data-testid="admin-step-up-password-form"]')
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });

  expect(api.post).toHaveBeenCalledTimes(1);
  expect(container.querySelector('[data-testid="admin-step-up-code-form"]')).toBeNull();
  expect(onVerified).toHaveBeenCalledTimes(1);
  expect(onCancel).toHaveBeenCalledTimes(1);

  await act(async () => root.unmount());
  container.remove();
});
