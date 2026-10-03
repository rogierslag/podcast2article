export function narrationFeature(environment: NodeJS.ProcessEnv) {
  const enabled = environment.BROWSER_NARRATION_ENABLED?.trim() || "false";
  if (enabled !== "true" && enabled !== "false") {
    throw new Error("BROWSER_NARRATION_ENABLED must be true or false");
  }
  const accounts = new Set(
    (environment.BROWSER_NARRATION_USERS || "")
      .split(",")
      .map((username) => username.trim())
      .filter(Boolean),
  );
  return (username: string): boolean =>
    enabled === "true" && (accounts.size === 0 || accounts.has(username));
}
