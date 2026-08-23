import { LOGIN_SURFACES, loginRequestPayload } from "./loginSurface";

test.each([
  [LOGIN_SURFACES.PLAYER, "PLAYER"],
  [LOGIN_SURFACES.ADMIN, "ADMIN"],
  [LOGIN_SURFACES.DISTRIBUTOR, "DISTRIBUTOR"],
  ["player", "PLAYER"],
])("identifies the intended login surface before the server creates a session", (surface, expected) => {
  expect(loginRequestPayload("operator@example.com", "not-a-real-password", surface)).toEqual({
    identifier: "operator@example.com",
    email: "operator@example.com",
    password: "not-a-real-password",
    login_surface: expected,
  });
});

test("fails closed for an unknown login surface", () => {
  expect(() => loginRequestPayload("user@example.com", "password", "UNKNOWN")).toThrow("Unknown login surface");
});
