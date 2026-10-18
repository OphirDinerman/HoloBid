# Holo Bid: Pokemon card and booster pack auctions

A working app: Node.js + SQLite server, real-time bidding over WebSockets, and a mobile-first web client (English and Hebrew, RTL) served by the same server.

## Run it locally (2 minutes)

```bash
npm install
DEV_AUTH=1 ADMIN_FB_IDS=dev:owner npm start
# open http://localhost:3000
```

`DEV_AUTH=1` replaces Google sign-in with a name box and shows SMS codes on screen. Sign in as **Owner** to see the admin panel; any other name will not see it.
Run the tests with `npm test`.

## What is implemented

- Google sign-in, mandatory SMS phone verification (one account per Google account and per phone number), mandatory Terms of Service acceptance (stored with version, time and IP).
- Live auctions for cards and boosters, listing form with photos, minutes/hours/days durations. **Two delivery modes**: *self pickup only*, or *self pickup or shipping* where the seller sets the shipping price and the buyer picks at bid time. The seller always enters the pickup city.
- **Contact details after a win**: buyer and seller see each other's phone number and Facebook contact on the order, with WhatsApp (`wa.me`) and Messenger (`m.me`) buttons. Details are shown only to the two people in that order. The Terms of Service (version 1.1) tell users about this.
- Binding bids, race-safe (single SQL transaction), minimum increment, anti-sniping (+2 min for late bids), bid history, real-time updates.
- Server-side auction closing, 24-hour payment window, order flow (paid, received, shipped, delivered), automatic non-payment case after 24h, buyer/seller reports.
- Public history of closed auctions with closing prices.
- **Search**: live auctions by title, set, condition, city and description (English and Hebrew words, several words at once) with an All/Cards/Booster tab, and search inside the history lists. Search runs in the browser over the loaded auctions, which is fine for a few thousand listings; for more, move it to a server-side query (SQLite FTS5 or Postgres full-text).
- **Notifications**: when someone outbids you, when you win an auction, and (for sellers) when your item sells. Bell icon with unread count and a list (in-app), toast messages while the site is open, and optional **device alerts** (Web Push) that arrive even when the site is closed. Each user can switch outbid/win alerts on or off. Push texts follow the user's chosen language (English/Hebrew).
- **Admin panel**: only Google accounts whose verified email is listed in `ADMIN_EMAILS` can see it. The server returns 404 on admin routes for everyone else, so it is hidden and not just a hidden button. The admin blocks the defaulting buyer or seller, with a required note and an audit log.

## Going live

1. **Hosting.** Any host that runs Node with a persistent disk: Render, Railway, Fly.io, or a small VPS. Use the included `Dockerfile`, mount a volume at `/data`, and serve over HTTPS (Google requires it).
2. **Google sign-in.** In console.cloud.google.com create a project, configure the OAuth consent screen (External, app name, support email, add your domain, privacy policy `<url>/privacy`, terms `<url>/terms`), then Credentials > Create credentials > OAuth client ID > *Web application*, with **Authorized JavaScript origins** = your site URL. Put the Client ID in `GOOGLE_CLIENT_ID`. Publish the consent screen (In production). Basic sign-in (name, email) needs no Google verification. The server verifies every ID token (signature via Google, client id, issuer, expiry, verified email).
3. **Your admin account.** Set `ADMIN_EMAILS=<your Google email>` and restart. Only that account sees the admin area.
4. **SMS.** Create a Twilio account and set `TWILIO_SID`, `TWILIO_TOKEN`, `TWILIO_FROM`. Check delivery to Israeli numbers on your plan.
5. **Secrets.** Set a long random `JWT_SECRET`. Never run with `DEV_AUTH=1` in production.
6. **Backups.** Back up `DB_FILE` daily (SQLite file, WAL mode).

## Facebook contact (optional)

Facebook sign-in is not used (Meta requires business verification for it). Users sign in with Google and verify a phone number. The phone number is the verified contact, and WhatsApp links are built from it. Each user may also type a Facebook profile link or username (optional, can be skipped), which enables Messenger/profile links after an auction. It is self-reported and not verified.

## Notifications setup

- Push keys are generated on the first run and kept in the database, so nothing to configure. Set `VAPID_SUBJECT=mailto:you@yourdomain.com` (a real contact address) because some push services require it.
- Device alerts need HTTPS and a supported browser. On iPhone, the site must first be added to the Home Screen (Share, then Add to Home Screen) before the browser allows push.
- Push delivery was tested with a simulated push service only. Please test once on your own phone and computer after going live.
- Not included yet: email/SMS alerts and payment reminders.

## Before real users (not built yet)

- **Payments.** Payment is confirmed manually between buyer and seller. For buyer protection add escrow through a marketplace payment provider (Stripe Connect or a local one); then non-payment cases mostly disappear.
- **Legal.** Have a lawyer review the Terms of Service (binding bids, 24-hour payment, blocking) and write a privacy policy. Facebook requires a privacy policy URL.
- **Scale.** One server process handles the MVP. For more traffic move to Postgres (the SQL is plain) and Redis pub/sub for WebSockets, and move photos to S3 or R2.
- **Missing features:** email/push notifications, listing edits, user ratings, search, proxy bidding, automated counterfeit review.
- **Last-sale prices.** eBay's sold-price data needs approved API access; add it as a server route that caches results, then show it in the auction page.

## Profile, legal pages, account deletion
- Profile page: contact details (edit phone with an SMS code, edit Facebook contact), Leading now / Published by me / Won by me, and "Delete my account".
- Deletion is refused while the user has live auctions, a leading bid, or open orders. Otherwise personal data is erased and records stay anonymous.
- `/privacy`, `/terms`, `/data-deletion` are draft templates (English + Hebrew). Set `CONTACT_EMAIL`, and have a lawyer review them before launch.

## Deploy on Render (Blueprint)
1. Push this folder to GitHub. In Render: New > Blueprint > pick the repo (uses `render.yaml`, Starter plan + 1GB disk at /data).
2. Fill the env vars it asks for: `ADMIN_EMAILS`, `GOOGLE_CLIENT_ID`, `TWILIO_*`, `CONTACT_EMAIL`. Never set `DEV_AUTH`.
3. Google sign-in: see "Going live" step 2. Add `https://<your-render-url>` as an authorized JavaScript origin.
4. Set `ADMIN_EMAILS` to your Google email (the admin area is hidden from everyone else).

## Tests
`node test.js` (Node 22). In sandboxes that cannot build better-sqlite3, tests were run through a node:sqlite shim; run them once on a normal machine with the real package.
