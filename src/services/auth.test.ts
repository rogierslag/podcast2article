import { describe, expect, it } from "vitest";
import {
  createUserAuth,
  expiredSessionCookie,
  readCookie,
  sessionCookie,
} from "./auth.js";

describe("user authentication", () => {
  it("is disabled without configured users", () => {
    const auth = createUserAuth(undefined, undefined);
    expect(auth.enabled).toBe(false);
    expect(auth.usernames).toEqual([]);
    expect(auth.authenticate("rogier", "anything")).toBeUndefined();
    expect(auth.sessionUser(undefined)).toBeUndefined();
  });

  it("authenticates each configured user independently", () => {
    const auth = createUserAuth(
      JSON.stringify({
        rogier: "correct horse battery staple",
        melvin: "another sufficiently long password",
      }),
      undefined,
    );
    const token = auth.authenticate(
      "melvin",
      "another sufficiently long password",
    );
    expect(
      auth.authenticate("melvin", "correct horse battery staple"),
    ).toBeUndefined();
    expect(auth.sessionUser(token)).toBe("melvin");
  });

  it("accepts a signed session until it expires", () => {
    const now = Date.UTC(2026, 7, 22);
    const auth = createUserAuth(
      '{"rogier":"a sufficiently long password"}',
      undefined,
    );
    const token = auth.createSession("rogier", now);
    expect(auth.sessionUser(token, now)).toBe("rogier");
    expect(
      auth.sessionUser(token, now + 30 * 24 * 60 * 60 * 1_000),
    ).toBeUndefined();
    expect(auth.sessionUser(`${token}changed`, now)).toBeUndefined();
  });

  it("invalidates sessions after credentials change", () => {
    const token = createUserAuth(
      '{"rogier":"old password long enough"}',
      undefined,
    ).createSession("rogier");
    expect(
      createUserAuth(
        '{"rogier":"new password long enough"}',
        undefined,
      ).sessionUser(token),
    ).toBeUndefined();
  });

  it("supports APP_PASSWORD as a temporary rogier fallback", () => {
    const auth = createUserAuth(undefined, "legacy password long enough");
    expect(auth.usernames).toEqual(["rogier"]);
    expect(
      auth.sessionUser(
        auth.authenticate("rogier", "legacy password long enough"),
      ),
    ).toBe("rogier");
  });

  it("rejects malformed account configuration", () => {
    expect(() => createUserAuth("not json", undefined)).toThrow(/geldige JSON/);
    expect(() =>
      createUserAuth('{"Admin":"long enough password"}', undefined),
    ).toThrow(/gebruikersnaam/);
    expect(() => createUserAuth('{"rogier":"short"}', undefined)).toThrow(
      /minimaal 16/,
    );
  });
});

describe("session cookies", () => {
  it("reads encoded cookie values", () => {
    expect(
      readCookie(
        "theme=dark; p2a_session=v2.test%2Evalue; other=x",
        "p2a_session",
      ),
    ).toBe("v2.test.value");
  });

  it.each([false, true])(
    "sets and clears Lax cookies with the same security attributes (secure=%s)",
    (secure) => {
      const cookie = sessionCookie("token", secure);
      const expiredCookie = expiredSessionCookie(secure);

      for (const value of [cookie, expiredCookie]) {
        expect(value).toContain("Path=/; HttpOnly; SameSite=Lax");
        expect(value.split("; ").includes("Secure")).toBe(secure);
      }
      expect(cookie).toContain("Max-Age=2592000");
      expect(expiredCookie).toContain("p2a_session=;");
      expect(expiredCookie).toContain("Max-Age=0");
    },
  );
});
