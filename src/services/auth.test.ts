import { describe, expect, it } from "vitest";
import { createPasswordAuth, expiredSessionCookie, readCookie, sessionCookie } from "./auth.js";

describe("password authentication", () => {
  it("is disabled without a password", () => {
    const auth = createPasswordAuth(undefined);
    expect(auth.enabled).toBe(false);
    expect(auth.createSession()).toBeUndefined();
    expect(auth.sessionIsValid(undefined)).toBe(false);
  });

  it("checks the password exactly", () => {
    const auth = createPasswordAuth("correct horse battery staple");
    expect(auth.passwordMatches("correct horse battery staple")).toBe(true);
    expect(auth.passwordMatches("correct horse battery staplE")).toBe(false);
  });

  it("accepts a signed session until it expires", () => {
    const now = Date.UTC(2026, 7, 22);
    const auth = createPasswordAuth("a sufficiently long password");
    const token = auth.createSession(now);
    expect(auth.sessionIsValid(token, now)).toBe(true);
    expect(auth.sessionIsValid(token, now + 30 * 24 * 60 * 60 * 1_000)).toBe(false);
    expect(auth.sessionIsValid(`${token}changed`, now)).toBe(false);
  });

  it("invalidates sessions after a password change", () => {
    const token = createPasswordAuth("old password").createSession();
    expect(createPasswordAuth("new password").sessionIsValid(token)).toBe(false);
  });
});

describe("session cookies", () => {
  it("reads encoded cookie values", () => {
    expect(readCookie("theme=dark; p2a_session=v1.test%2Evalue; other=x", "p2a_session")).toBe("v1.test.value");
  });

  it("uses browser security attributes", () => {
    expect(sessionCookie("token", true)).toContain("HttpOnly; SameSite=Strict");
    expect(sessionCookie("token", true)).toContain("Secure");
    expect(expiredSessionCookie(false)).toContain("Max-Age=0");
  });
});
