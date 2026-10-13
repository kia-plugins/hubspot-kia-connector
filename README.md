# HubSpot connector for KIAgent

Indexes a HubSpot portal into local KIAgent memory via a read-only Private
App token. Contacts, companies, sequence emails and tasks are folded into
per-organisation **dossiers**. Deals, tickets, notes, calls, meetings, replies
and attachments stay as individual documents.

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

- **Dossiers** (`hubspot.dossier`). Contacts and companies are grouped by
  organisation:
  - the contact's email domain, or their company's domain;
  - "Individuals — YYYY-MM" for webmail or no-email contacts, by creation
    month.

  Each contact section lists that contact's outbound sequence emails and
  tasks. Engagements with no contact or company go to "Unassigned activity —
  YYYY-MM". Large organisations are split into parts of at most 8,000
  characters ("Nike (nike.com) — part 2"). Very long sections are truncated
  with a link to the record in HubSpot.
- One document per **deal, ticket, note, call, meeting**, per **incoming
  email**, and per **outbound email that has attachments**. These have no
  parent document; related contacts, deals, tickets and companies are linked
  in the body and kept in metadata.
- **Attachments** on emails, notes and meetings (≤50 MB) — extracted and
  OCR'd by the KIAgent platform.

## Sync behavior

- **Backfill:** pages deals, tickets, notes, calls, meetings and emails with
  crash-safe checkpoints after every page.
- **Live sync:** every **30 minutes**, modified records are picked up via the
  CRM search API with per-type watermarks; each tick is capped at a small
  request budget, stalest types first.
- **Deletions:** each tick also sweeps HubSpot's archived-record listing and
  archives those documents (and their attachment documents) in KIAgent.
  GDPR hard-deletes leave no archived record and are not detected.
- **Dossiers** are rebuilt from a full listing every **6 hours**: about 2,000
  API requests and roughly 11 minutes for a 130k-contact portal. A new lead,
  sequence send or LinkedIn task therefore appears within about 6 hours.
  Stale dossier parts are archived when a rebuild completes. A rebuild that's
  interrupted retries after an hour.

## Upgrading from 0.1.x

0.2.0 changes how HubSpot is indexed: contacts, companies, sequence emails and
tasks are folded into per-organisation dossiers. Remove the HubSpot account,
update the connector from the Marketplace, then add the account again. An
account left in place shows "Remove and re-add the HubSpot account to upgrade
to dossiers".

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
