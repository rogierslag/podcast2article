# Shared article monitoring

Shared permalinks record anonymous usage for journey J6: whether a recipient
loads the article and spends time reading it. This measures engagement, not
comprehension or unique people. Collection starts when this version is deployed;
there is no historical backfill.

- **Load:** the article has rendered in a visible browser tab. HTML previews,
  audio requests, and article API requests alone do not count.
- **Read:** that visit accumulates at least 30 seconds in a visible tab, with
  activity within the previous minute, and reaches at least 90% scroll progress.
  Pointer, keyboard, and scroll activity renew the activity window. The initial
  page opening also starts an activity window. Suspended timers do not add time.
- A refresh starts a new visit. The visitor's own explicit read state is unchanged.

The owner can retrieve counts from `GET /api/jobs/:id/share-stats` using their
normal authenticated session. The response contains `loads`, `reads`, and the
optional `lastLoadedAt` and `lastReadAt` timestamps. Another account cannot access
these statistics. The public reader receives neither counts nor visitor receipts.
No new interface controls are added.

Counts are persisted with the article. Up to 256 recent visit receipts are kept
for 24 hours to deduplicate retries and reject reads without a corresponding load.
Receipts contain only a digest of a random page-visit ID, its load time, and a read
flag. They are pruned on the next newly counted event; totals remain. Retries after
receipt eviction can count as another load, and old visits cannot record a read.
The server also requires 30 seconds between accepting a load and accepting a read.

No IP address, user agent, referrer, cookie, or cross-page visitor ID is collected
by this feature. Monitoring requests omit credentials. Existing infrastructure
access logs are separate. Network failures retry while the page stays open;
closing the page can lose an event. Scripts, blocked requests, and automated
browsers can affect totals: these are approximate usage counts, not billing or
abuse-resistant measurements. A holder of a valid permalink can submit events
for that article, but cannot change owner read state or inspect private data.

## API contract

The rendered reader sends a credential-free request to
`POST /api/shared/:token/events`, with `Content-Type: application/json`:

```json
{
  "visitId": "c7189d34-f136-497d-9fd4-fb6a19a31b3a",
  "event": "load"
}
```

The browser creates a fresh UUID for each page load and reuses it for retries and
that visit's `read` event. Only `load` and `read` are accepted; unknown fields and
invalid UUIDs return `400`. An invalid, deleted, or unavailable capability returns
`404`. Accepted and duplicate events return `204` without a response payload.
A read with no retained load, an expired receipt, or less than 30 seconds since
its load returns `409`. Monitoring failures do not block the reader.

The owner can inspect their article while signed in using a same-origin request:

```javascript
const response = await fetch(`/api/jobs/${articleId}/share-stats`);
const statistics = await response.json();
```

Example response:

```json
{
  "loads": 12,
  "reads": 4,
  "lastLoadedAt": "2026-09-19T12:00:00.000Z",
  "lastReadAt": "2026-09-19T12:00:35.000Z"
}
```

Untracked completed articles return zero counts and omit timestamps. With
authentication enabled, signed-out requests return `401`; another owner's,
deleted, malformed, or unfinished job returns `404`. Responses use `no-store`.
In local development without authentication, the owner is the `local` account.
The owner job payload also contains the stored analytics; the dedicated endpoint
returns only aggregate fields. Saved copies start without the original counters.

## Deployment and verification

A normal application release enables collection. No migration, configuration
flag, analytics account, or scheduled job is required. Job backups retain the
counts; restoring an older backup restores its older totals. Receipt expiration
is lazy, not a scheduled deletion, so an inactive article can retain old receipts
until a new event changes its statistics. At most 256 receipts are stored.

Unit tests cover count deduplication, receipt expiry, bounded retention, and active
reading time. The real HTTP tests check validation, persistence, restored receipts,
public payload shaping, and owner isolation. These automated checks do not prove
production deployment or real-world reading behaviour. See the
[operational checks](OPERATIONS.md#shared-article-usage) for deployment verification.
