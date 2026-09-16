import { describe, expect, it } from "vitest";
import { supportsIOSShortcutInstall } from "../../public/ios-shortcut.js";

describe("iOS Shortcut installation visibility", () => {
  it.each([
    [
      "iPhone Safari",
      { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)" },
    ],
    [
      "iPhone Chrome",
      {
        userAgent:
          "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) CriOS/128",
      },
    ],
    [
      "iPad mobile website",
      { userAgent: "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)" },
    ],
    [
      "iPad desktop website",
      {
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)",
        platform: "MacIntel",
        maxTouchPoints: 5,
      },
    ],
  ])("offers the installer on %s", (_name, device) => {
    expect(supportsIOSShortcutInstall(device)).toBe(true);
  });

  it.each([
    [
      "Mac",
      {
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)",
        platform: "MacIntel",
        maxTouchPoints: 0,
      },
    ],
    [
      "Android",
      {
        userAgent: "Mozilla/5.0 (Linux; Android 14) Mobile",
        platform: "Linux armv8l",
        maxTouchPoints: 5,
      },
    ],
    [
      "Windows touchscreen",
      {
        userAgent: "Mozilla/5.0 (Windows NT 10.0)",
        platform: "Win32",
        maxTouchPoints: 10,
      },
    ],
    ["unknown device", {}],
  ])("hides the installer on %s", (_name, device) => {
    expect(supportsIOSShortcutInstall(device)).toBe(false);
  });
});
