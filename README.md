# HubSpot connector for KIAgent

Indexes a HubSpot portal into local KIAgent memory — contacts, companies,
deals and tickets as structured records, plus the full engagement timeline
(emails, notes, calls, meetings, tasks) and engagement attachments, kept in
sync incrementally via a read-only Private App token.

## Install

Install from the KIAgent marketplace (Extensions → HubSpot). The extension
requests the `net` capability — it talks only to `api.hubapi.com` and
HubSpot's signed file-download URLs.

## Connect your portal

1. In HubSpot: **Settings → Integrations → Private Apps → Create private app**.
   Name it e.g. `KIAgent`.
2. On the **Scopes** tab enable exactly these read scopes:
   `crm.objects.contacts.read` `crm.objects.companies.read`
   `crm.objects.deals.read` `tickets` `crm.objects.owners.read`
   `sales-email-read` `files` `account-info.security.read`
3. Create the app, open the **Auth** tab, copy the access token (`pat-…`)
   and paste it into the KIAgent connect wizard.

One KIAgent account per portal; connect again for additional portals.

## What gets indexed

- One document per **contact, company, deal, ticket** — key properties plus
  all custom properties, with owner names and pipeline/stage labels resolved.
- One document per **email, note, call, meeting, task**, attached to its most
  relevant record (contact > deal > ticket > company); all other
  associations kept as metadata.
- **Attachments** on emails, notes and meetings (≤50 MB) — extracted and
  OCR'd by the KIAgent platform.

## Sync behavior

- **Backfill:** pages every record type oldest-first (objects before
  engagements) with crash-safe checkpoints after every page.
- **Live sync:** every **30 minutes**, modified records are picked up via the
  CRM search API with per-type watermarks; each tick is capped at a small
  request budget, stalest types first.
- **Deletions:** each tick also sweeps HubSpot's archived-record listing and
  archives those documents (and their attachment documents) in KIAgent.
  GDPR hard-deletes leave no archived record and are not detected.

## Privacy

This extension has no server of its own and no analytics. Your token is
stored in KIAgent's encrypted credential vault; data flows only from
HubSpot's API into your local KIAgent memory — nothing is sent anywhere else.

## Build from source

```bash
npm install
npm test
npm run typecheck
npm run build
npm pack
```

The `.tgz` produced by `npm pack` is the installable extension artifact.

## License

MIT
