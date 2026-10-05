import { describe, expect, it } from "vitest";
import { ownerUsername } from "./owner-context.js";

describe("owner request context", () => {
  it("uses the account established by authentication", () => {
    const response = { locals: { username: "rogier" } };

    const username = ownerUsername(response);

    expect(username).toBe("rogier");
  });

  it.each([undefined, null, 123, { username: "rogier" }])(
    "rejects an untrusted account value (%s)",
    (username) => {
      const response = { locals: { username } };

      expect(() => ownerUsername(response)).toThrow("authenticated user");
    },
  );
});
