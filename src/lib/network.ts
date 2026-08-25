import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const PRIVATE_HOSTS = new Set(["localhost", "0.0.0.0", "::1"]);

function isPrivateIp(address: string): boolean {
  if (
    address === "::1" ||
    address.startsWith("fc") ||
    address.startsWith("fd") ||
    address.startsWith("fe80:")
  ) {
    return true;
  }
  if (!isIP(address.includes("%") ? address.split("%")[0]! : address)) {
    return false;
  }
  const parts = address.split(".").map(Number);
  if (parts.length !== 4) {
    return false;
  }
  return (
    parts[0] === 10 ||
    parts[0] === 127 ||
    (parts[0] === 169 && parts[1] === 254) ||
    (parts[0] === 172 && (parts[1] ?? 0) >= 16 && (parts[1] ?? 0) <= 31) ||
    (parts[0] === 192 && parts[1] === 168) ||
    parts[0] === 0
  );
}

export async function assertPublicUrl(value: string): Promise<URL> {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Alleen publieke HTTP(S)-bronnen zijn toegestaan.");
  }
  const hostname = url.hostname.toLowerCase();
  if (PRIVATE_HOSTS.has(hostname) || hostname.endsWith(".local")) {
    throw new Error("Privé-netwerkadressen zijn niet toegestaan.");
  }
  if (isIP(hostname)) {
    if (isPrivateIp(hostname)) {
      throw new Error("Privé-netwerkadressen zijn niet toegestaan.");
    }
  } else {
    const addresses = await lookup(hostname, { all: true });
    if (
      !addresses.length ||
      addresses.some(({ address }) => isPrivateIp(address))
    ) {
      throw new Error(
        "De bron verwijst niet uitsluitend naar een publiek netwerkadres.",
      );
    }
  }
  return url;
}

export async function safeFetch(
  input: string,
  init: RequestInit = {},
  redirects = 0,
): Promise<Response> {
  const url = await assertPublicUrl(input);
  const response = await fetch(url, {
    ...init,
    redirect: "manual",
    signal: init.signal ?? AbortSignal.timeout(30_000),
  });
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    if (redirects >= 6) {
      throw new Error("Te veel redirects bij het ophalen van de bron.");
    }
    const location = response.headers.get("location");
    if (!location) {
      throw new Error("Redirect zonder bestemming ontvangen.");
    }
    return safeFetch(new URL(location, url).toString(), init, redirects + 1);
  }
  return response;
}
