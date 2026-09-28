# Admin problem emails

Set `ADMIN_ALERT_EMAIL`, `SES_FROM_EMAIL`, `SES_REGION`, and `PUBLIC_BASE_URL` to enable plain-text operator alerts.
The sender uses the standard AWS credential chain, shared with article backups; SES and S3 can use different regions.
The configured recipient is an installation administrator and receives problem metadata across all configured accounts.
Leave `ADMIN_ALERT_EMAIL` empty to disable alerts.
Invalid enabled configuration fails startup before job recovery begins.

```dotenv
ADMIN_ALERT_EMAIL=admin@example.com
SES_FROM_EMAIL=reads@example.com
SES_REGION=us-east-1
PUBLIC_BASE_URL=https://reads.example.com
```

The worker checks persisted state every minute for failed jobs, failed checks of active podcast subscriptions, and the updater's deployment failure marker.
Job emails include the episode title, account, job ID, failed processing step when available, and an authenticated link.
A saved `insufficient_quota` provider code produces an explicit instruction to check OpenAI credits.
Unknown errors point to server logs rather than including raw exception messages.
No transcript, article body, source URL, share token, API key, or provider response body is included.
Links require signing in as the owning account; an admin email does not grant cross-account application access.

The first scan waits five minutes before sending, then the worker sends at most one digest every five minutes with at most 20 problems.
Remaining problems appear in later digests.
Successful notifications are recorded in `data/admin-alerts/state.json`, which survives deployments.
An unchanged failure is sent once; a new failed job attempt or a series that recovers and subsequently fails can produce another alert.
Problems that recover before being emailed are omitted.
No paid work is retried by the alert worker.

SES failures retain unsent problems and back off for 15 minutes, including across restarts.
A crash after SES accepts a message but before its receipt is saved can produce a duplicate later.
SES acceptance is not proof of inbox delivery; test the destination mailbox before relying on alerts.
A corrupt alert receipt file is retained and logged rather than replaced with an empty history.
Run only one server against the data directory.

This is application problem reporting, not an external uptime monitor.
It cannot send while the host, application, AWS credentials, SES, or network is unavailable.
Backup failures and individual HTTP request failures remain in server logs; they are not included in this initial alert scope.
If a scan cannot read application state, it sends a generic monitoring-failure alert without exposing the unreadable content.
Events that begin and recover between scans may be missed.

## AWS and DNS setup

Verify the sending domain in the selected SES region and publish its DKIM records at the DNS provider.
An existing verified domain with successful DKIM can be reused for an address beneath that domain without a separate mailbox identity.
Preserve receiving MX records.
Confirm that SES has production access in that region before sending to unverified recipients.
See AWS's [identity setup](https://docs.aws.amazon.com/ses/latest/dg/creating-identities.html) and [production access](https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html) documentation.

Grant the application's IAM principal only `ses:SendEmail` for the verified identity, restricted to the configured From address.
Replace the example account, domain, region and sender below.
No SMTP password or additional access key is needed when the application already has AWS credentials.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "ses:SendEmail",
      "Resource": "arn:aws:ses:us-east-1:123456789012:identity/example.com",
      "Condition": {
        "StringEquals": { "ses:FromAddress": "reads@example.com" }
      }
    }
  ]
}
```

For managed deployments, put the settings in `/etc/podcast2article.env` and activate them through the regular deployment updater.
Keep the alert receipt directory with the persistent application data.
Existing unresolved failures are eligible for a first alert when this feature is enabled; completed jobs are excluded.
