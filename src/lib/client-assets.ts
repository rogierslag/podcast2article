import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

interface ClientAssets {
  templateDirectory: string;
  assetDirectory: string;
  filenames: ReadonlySet<string>;
}

export async function clientAssets(
  serverDirectory: string,
): Promise<ClientAssets> {
  const assetDirectory = path.join(serverDirectory, "client");
  const templateDirectory = path.join(serverDirectory, "client-templates");
  if (!existsSync(templateDirectory)) {
    throw new Error(
      "Client assets are missing; run yarn run build:client before starting the server.",
    );
  }
  const manifest: unknown = JSON.parse(
    await readFile(path.join(templateDirectory, "assets.json"), "utf8"),
  );
  if (
    !Array.isArray(manifest) ||
    !manifest.every(
      (filename: unknown) =>
        typeof filename === "string" && /^[\w-]+\.(js|css)$/.test(filename),
    )
  ) {
    throw new Error("Invalid client asset manifest");
  }
  const filenames = new Set<string>(manifest);
  return { templateDirectory, assetDirectory, filenames };
}
