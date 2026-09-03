import { AUTH_PANELS, authPanelFromQuery, authSearchForPanel, frontPathForAuthPanel, guestPlayAuthPath } from "./frontDoor";

test("authPanelFromQuery maps aliases onto frontpage panels", () => {
  expect(authPanelFromQuery(null)).toBe(AUTH_PANELS.HERO);
  expect(authPanelFromQuery("login")).toBe(AUTH_PANELS.LOGIN);
  expect(authPanelFromQuery("sign-in")).toBe(AUTH_PANELS.LOGIN);
  expect(authPanelFromQuery("register")).toBe(AUTH_PANELS.REGISTER);
  expect(authPanelFromQuery("signup")).toBe(AUTH_PANELS.REGISTER);
  expect(authPanelFromQuery("forgot-password")).toBe(AUTH_PANELS.FORGOT);
  expect(authPanelFromQuery("unknown")).toBe(AUTH_PANELS.HERO);
});

test("frontPathForAuthPanel stays on slash with auth query", () => {
  expect(frontPathForAuthPanel(AUTH_PANELS.LOGIN)).toBe("/?auth=login");
  expect(frontPathForAuthPanel(AUTH_PANELS.REGISTER)).toBe("/?auth=register");
  expect(frontPathForAuthPanel(AUTH_PANELS.FORGOT)).toBe("/?auth=forgot");
  expect(frontPathForAuthPanel(AUTH_PANELS.LOGIN, true)).toBe("/?auth=login&registered=1");
  expect(authSearchForPanel(AUTH_PANELS.HERO)).toBe("");
});

test("guest play entry points open the unified login panel with a create-account tab", () => {
  expect(guestPlayAuthPath()).toBe("/?auth=login");
});
