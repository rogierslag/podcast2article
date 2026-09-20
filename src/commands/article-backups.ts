import path from "node:path";
import { S3Client } from "@aws-sdk/client-s3";
import {
  ArticleBackupWorker,
  backupConfiguration,
  fetchArticleBackup,
  restoreArticleBackup,
} from "../services/article-backups.js";

const [command, owner, id, ...extra] = process.argv.slice(2);
const config = backupConfiguration();
if (!config) {
  throw new Error(
    "Configure ARTICLE_BACKUP_BUCKET and ARTICLE_BACKUP_REGION first",
  );
}
const root = path.resolve("data");
if (command === "backfill" && !owner) {
  const failures = await new ArticleBackupWorker(root, config).flush();
  console.log(`Article backup backfill finished: ${failures} failures`);
  process.exitCode = failures ? 1 : 0;
} else if (command === "restore" && owner && id && extra.length === 0) {
  const client = new S3Client({ region: config.region, maxAttempts: 3 });
  try {
    const destination = await restoreArticleBackup(
      root,
      await fetchArticleBackup(client, config, owner, id),
      owner,
      id,
    );
    console.log(`Restored article: ${destination}`);
  } finally {
    client.destroy();
  }
} else {
  throw new Error(
    "Usage: article-backups backfill | restore <username> <job-id>",
  );
}
