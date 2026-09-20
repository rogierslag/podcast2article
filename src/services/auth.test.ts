import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createUserAuth,
  expiredSessionCookie,
  readCookie,
  sessionCookie,
} from "./auth.js";

describe("user authentication", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([undefined, "", "   "])(
    "is disabled with APP_USERS=%j",
    (rawUsers) => {
      vi.stubEnv("APP_USERS", rawUsers);

      const auth = createUserAuth();

      expect(auth.enabled).toBe(false);
      expect(auth.usernames).toEqual([]);
      expect(auth.authenticate("rogier", "anything")).toBeUndefined();
      expect(auth.sessionUser(undefined)).toBeUndefined();
    },
  );

  it("authenticates each configured user independently", () => {
    const auth = createUserAuth(
      JSON.stringify({
        rogier: "correct horse battery staple",
        john_appleseed: "another sufficiently long password",
      }),
    );
    const token = auth.authenticate(
      "john_appleseed",
      "another sufficiently long password",
    );
    expect(
      auth.authenticate("john_appleseed", "correct horse battery staple"),
    ).toBeUndefined();
    expect(auth.sessionUser(token)).toBe("john_appleseed");
  });

  it("accepts a signed session until it expires", () => {
    const now = Date.UTC(2026, 7, 22);
    const auth = createUserAuth('{"rogier":"a sufficiently long password"}');
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
    ).createSession("rogier");
    expect(
      createUserAuth('{"rogier":"new password long enough"}').sessionUser(
        token,
      ),
    ).toBeUndefined();
  });

  it("ignores the removed APP_PASSWORD setting", () => {
    vi.stubEnv("APP_USERS", undefined);
    vi.stubEnv("APP_PASSWORD", "legacy password long enough");

    const auth = createUserAuth();

    expect(auth.enabled).toBe(false);
    expect(auth.usernames).toEqual([]);
    expect(
      auth.authenticate("rogier", "legacy password long enough"),
    ).toBeUndefined();
    expect(auth.createSession("rogier")).toBeUndefined();
  });

  it("loads configured users from APP_USERS", () => {
    vi.stubEnv("APP_USERS", '{"rogier":"a sufficiently long password"}');

    const auth = createUserAuth();
    const token = auth.authenticate("rogier", "a sufficiently long password");

    expect(auth.enabled).toBe(true);
    expect(auth.usernames).toEqual(["rogier"]);
    expect(auth.sessionUser(token)).toBe("rogier");
  });

  it("rejects malformed account configuration", () => {
    expect(() => createUserAuth("not json")).toThrow(/geldige JSON/);
    expect(() => createUserAuth('{"Admin":"long enough password"}')).toThrow(
      /gebruikersnaam/,
    );
    expect(() => createUserAuth('{"rogier":"short"}')).toThrow(/minimaal 16/);
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
