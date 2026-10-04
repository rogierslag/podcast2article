# Core Web Vitals monitoring

The application uses the locally bundled `web-vitals` dependency to measure Largest Contentful Paint (LCP), Cumulative Layout Shift (CLS), and Interaction to Next Paint (INP).
The module is deferred and loads on login, owner, shared-article, and shared-not-found pages.
It does not change the reader interface or send measurements to a third-party service.
WebDriver browsers are excluded so browser suites and automated audits do not enter the field dataset.

## Collection and privacy

The browser sends JSON to `POST /api/web-vitals` with `fetch`, `keepalive`, omitted credentials, and no referrer.
Collection uses the library's default reporting lifecycle, including finalization when a page becomes hidden.
There are no automatic retries or user-visible errors when delivery fails.

Only these fields are accepted:

| Field            | Meaning                                                                                                               |
| ---------------- | --------------------------------------------------------------------------------------------------------------------- |
| `name`           | `LCP`, `CLS`, or `INP`                                                                                                |
| `value`          | Milliseconds for LCP/INP; unitless score for CLS                                                                      |
| `id`             | Library-generated random metric ID for deduplication, not a persistent visitor ID                                     |
| `sequence`       | Increasing report number for that metric ID                                                                           |
| `navigationType` | Library navigation category, including back/forward-cache restores                                                    |
| `page`           | Fixed page category: `login`, `new-article`, `articles`, `article`, `series`, `shared-article`, or `shared-not-found` |
| `layout`         | Initial viewport category: `narrow` below 800 CSS pixels, otherwise `wide`                                            |
| `release`        | Full deployed commit SHA, or `null` if unavailable                                                                    |

The server adds `receivedAt` in UTC.
The client and strict server schema exclude account identity, URLs, query strings, hashes, article IDs, share tokens, referrers, raw user agents, DOM selectors, performance entries, and attribution text.
The telemetry store does not record IP addresses; the existing request limiter still uses them transiently for admission.
Infrastructure access logs have their own configuration and retention policy.

## Ingestion and storage

The endpoint is public so anonymous readers can report performance without an account.
It provides no read endpoint and cannot mutate article data or reading state.
Cross-site browser submissions and mismatched `Origin` headers are rejected.
Payload fields and values are bounded, including one hour for LCP/INP and 100 for CLS.
The route allows 60 submissions per minute per IP and also shares the application's global request quota.

Accepted measurements are appended to `data/web-vitals/YYYY-MM-DD.jsonl` in UTC, outside account storage and source control.
Writes are serialized within the application process and acknowledged only after the append completes.
New files use mode `0600`.
The store assumes one application writer per data directory, matching the deployment model.

Each daily file is capped at 10 MiB.
On the first submission of each UTC day, the store removes daily files older than the current day and preceding 29 days.
An idle deployment may retain expired files until the next submission.
Only matching daily filenames are pruned; unrelated files are preserved.

Responses are `204` after persistence, `400` for invalid input, `403` for disallowed origins, `429` for quota or daily capacity limits, and `503` for storage failures.
Rejected measurements do not block reading.
Telemetry stays on the local data volume across deployments and restarts; article-only S3 backups do not include it.
Full-volume backups may retain older telemetry beyond the live retention window and should apply their own retention policy.

## Reading the data

After `yarn run build`, run:

```sh
yarn run report:web-vitals
# Optionally read a copied telemetry directory.
yarn run report:web-vitals /path/to/web-vitals
```

The command outputs sample counts and nearest-rank p75 grouped by page, layout, release, navigation type, and metric.
It keeps the highest `sequence` for each metric ID before aggregation so visibility changes do not turn one measurement into multiple samples.
It counts discarded malformed lines in `invalidLines`, including a potentially truncated append after a crash.
Missing metrics remain absent rather than becoming zero.
The command returns aggregates only; stored reports have no public download route.

## Interpretation and limits

Good thresholds are LCP at most 2,500 ms, INP at most 200 ms, and CLS at most 0.1, assessed at the 75th percentile.
See [Google's Web Vitals guidance](https://web.dev/articles/vitals) and the [library documentation](https://github.com/GoogleChrome/web-vitals).
Small samples are diagnostic observations, not evidence of an overall pass rate.

Viewport category describes layout rather than a physical device or operating system.
Unsupported browser metrics and visits without qualifying interactions may have no measurement, particularly INP.
Keep browser coverage, failed deliveries, quota limits, and sample counts in mind when comparing releases.
Client measurements are untrusted and can be forged; they must not influence authorization, billing, or article state.

The page category is captured at document initialization.
Owner hash navigation does not create a fresh measurement lifecycle, and the current integration does not enable experimental soft-navigation measurement.
INP can therefore include interactions later in the same document while retaining its initial page category.
Signed-in and anonymous shared readers are combined because collection does not inspect or report authentication state.
Use targeted browser diagnostics to separate their layout behavior when investigating shared-page shifts.
