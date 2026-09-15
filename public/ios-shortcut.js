export function supportsIOSShortcutInstall({
  userAgent = "",
  platform = "",
  maxTouchPoints = 0,
} = {}) {
  // iPadOS can identify as a Mac when requesting desktop websites.
  // This controls discoverability, not authorization to download the file.
  return (
    /iPhone|iPad|iPod/.test(userAgent) ||
    (platform === "MacIntel" && maxTouchPoints > 1)
  );
}
