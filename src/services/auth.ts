import {
  createHash,
  createHmac,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";

export const SESSION_COOKIE_NAME = "p2a_session";
export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

const SESSION_VERSION = "v2";
const KEY_SALT = "podcast2article/session/v2";
const USERNAME_PATTERN = /^[a-z][a-z0-9_-]{1,31}$/;

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function equal(left: string, right: string): boolean {
  return timingSafeEqual(digest(left), digest(right));
}

function parseUsers(
  rawUsers: string | undefined,
  legacyPassword: string | undefined,
): Map<string, string> {
  if (!rawUsers?.trim()) {
    return legacyPassword?.trim()
      ? new Map([["rogier", legacyPassword]])
      : new Map();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawUsers);
  } catch {
    throw new Error(
      'APP_USERS moet geldige JSON zijn, bijvoorbeeld {"rogier":"wachtwoord"}.',
    );
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error(
      "APP_USERS moet een JSON-object met gebruikersnamen en wachtwoorden zijn.",
    );
  }

  const users = new Map<string, string>();
  for (const [username, password] of Object.entries(parsed)) {
    if (!USERNAME_PATTERN.test(username)) {
      throw new Error(`Ongeldige gebruikersnaam in APP_USERS: ${username}`);
    }
    if (typeof password !== "string" || password.length < 16) {
      throw new Error(
        `Het wachtwoord voor ${username} moet minimaal 16 tekens lang zijn.`,
      );
    }
    users.set(username, password);
  }
  if (!users.size) {
    throw new Error("APP_USERS moet ten minste één gebruiker bevatten.");
  }
  return users;
}

export interface UserAuth {
  enabled: boolean;
  usernames: string[];
  authenticate(username: string, password: string): string | undefined;
  createSession(username: string, now?: number): string | undefined;
  sessionUser(token: string | undefined, now?: number): string | undefined;
}

export function createUserAuth(
  rawUsers = process.env.APP_USERS,
  legacyPassword = process.env.APP_PASSWORD,
): UserAuth {
  const users = parseUsers(rawUsers, legacyPassword);
  const credentialFingerprint = [...users.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([username, password]) => `${username}\0${password}`)
    .join("\0");
  const signingKey = users.size
    ? scryptSync(credentialFingerprint, KEY_SALT, 32)
    : undefined;

  function signature(payload: string): string {
    return createHmac("sha256", signingKey!)
      .update(payload, "utf8")
      .digest("base64url");
  }

  function createSession(
    username: string,
    now = Date.now(),
  ): string | undefined {
    if (!signingKey || !users.has(username)) {
      return undefined;
    }
    const expiresAt = Math.floor(now / 1_000) + SESSION_MAX_AGE_SECONDS;
    const encodedUsername = Buffer.from(username, "utf8").toString("base64url");
    const payload = `${SESSION_VERSION}.${encodedUsername}.${expiresAt}`;
    return `${payload}.${signature(payload)}`;
  }

  return {
    enabled: users.size > 0,
    usernames: [...users.keys()],
    authenticate(username: string, password: string): string | undefined {
      const configuredPassword = users.get(username);
      return configuredPassword && equal(password, configuredPassword)
        ? createSession(username)
        : undefined;
    },
    createSession,
    sessionUser(
      token: string | undefined,
      now = Date.now(),
    ): string | undefined {
      if (!signingKey || !token) {
        return undefined;
      }
      const [
        version,
        encodedUsername,
        expiresAtText,
        receivedSignature,
        ...rest
      ] = token.split(".");
      if (
        rest.length ||
        version !== SESSION_VERSION ||
        !encodedUsername ||
        !expiresAtText ||
        !receivedSignature
      ) {
        return undefined;
      }
      let username: string;
      try {
        username = Buffer.from(encodedUsername, "base64url").toString("utf8");
      } catch {
        return undefined;
      }
      if (!users.has(username)) {
        return undefined;
      }
      const expiresAt = Number(expiresAtText);
      const nowSeconds = Math.floor(now / 1_000);
      if (
        !Number.isSafeInteger(expiresAt) ||
        expiresAt <= nowSeconds ||
        expiresAt > nowSeconds + SESSION_MAX_AGE_SECONDS
      ) {
        return undefined;
      }
      const payload = `${version}.${encodedUsername}.${expiresAtText}`;
      return equal(receivedSignature, signature(payload))
        ? username
        : undefined;
    },
  };
}

export function readCookie(
  cookieHeader: string | undefined,
  name: string,
): string | undefined {
  for (const part of cookieHeader?.split(";") ?? []) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) {
      continue;
    }
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function sessionCookie(token: string, secure: boolean): string {
  return [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${SESSION_MAX_AGE_SECONDS}`,
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

export function expiredSessionCookie(secure: boolean): string {
  return [
    `${SESSION_COOKIE_NAME}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}
