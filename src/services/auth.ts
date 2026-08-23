import { createHash, createHmac, scryptSync, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE_NAME = "p2a_session";
export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

const SESSION_VERSION = "v1";
const KEY_SALT = "podcast2article/session/v1";

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function equal(left: string, right: string): boolean {
  return timingSafeEqual(digest(left), digest(right));
}

export interface PasswordAuth {
  enabled: boolean;
  passwordMatches(candidate: string): boolean;
  createSession(now?: number): string | undefined;
  sessionIsValid(token: string | undefined, now?: number): boolean;
}

export function createPasswordAuth(password = process.env.APP_PASSWORD): PasswordAuth {
  const configuredPassword = password?.trim() ? password : undefined;
  const signingKey = configuredPassword
    ? scryptSync(configuredPassword, KEY_SALT, 32)
    : undefined;

  function signature(payload: string): string {
    return createHmac("sha256", signingKey!).update(payload, "utf8").digest("base64url");
  }

  return {
    enabled: Boolean(configuredPassword),
    passwordMatches(candidate: string): boolean {
      return configuredPassword ? equal(candidate, configuredPassword) : false;
    },
    createSession(now = Date.now()): string | undefined {
      if (!signingKey) return undefined;
      const expiresAt = Math.floor(now / 1_000) + SESSION_MAX_AGE_SECONDS;
      const payload = `${SESSION_VERSION}.${expiresAt}`;
      return `${payload}.${signature(payload)}`;
    },
    sessionIsValid(token: string | undefined, now = Date.now()): boolean {
      if (!signingKey || !token) return false;
      const [version, expiresAtText, receivedSignature, ...rest] = token.split(".");
      if (rest.length || version !== SESSION_VERSION || !expiresAtText || !receivedSignature) return false;
      const expiresAt = Number(expiresAtText);
      const nowSeconds = Math.floor(now / 1_000);
      if (!Number.isSafeInteger(expiresAt) || expiresAt <= nowSeconds || expiresAt > nowSeconds + SESSION_MAX_AGE_SECONDS) return false;
      return equal(receivedSignature, signature(`${version}.${expiresAtText}`));
    },
  };
}

export function readCookie(cookieHeader: string | undefined, name: string): string | undefined {
  for (const part of cookieHeader?.split(";") ?? []) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
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
    "SameSite=Strict",
    `Max-Age=${SESSION_MAX_AGE_SECONDS}`,
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

export function expiredSessionCookie(secure: boolean): string {
  return [
    `${SESSION_COOKIE_NAME}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    "Max-Age=0",
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}
