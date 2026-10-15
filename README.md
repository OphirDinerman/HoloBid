# Holo Bid: Pokemon card and booster pack auctions

A working app: Node.js + SQLite server, real-time bidding over WebSockets, and a mobile-first web client (English and Hebrew, RTL) served by the same server.

## Run it locally (2 minutes)

```bash
npm install
DEV_AUTH=1 ADMIN_FB_IDS=dev:owner npm start
# open http://localhost:3000
```

`DEV_AUTH=1` replaces Facebook with a name box and shows SMS codes on screen. Sign in as **Owner** to see the admin panel; any other name will not see it.
Run the tests with `npm test`.

## What is implemented

- Facebook sign-in, mandatory SMS phone verification (one account per Facebook ID and per phone number), mandatory Terms of Service acceptance (stored with version, time and IP).
- Live auctions for cards and boosters, listing form with photos, shipping paid by buyer or seller (shown before bidding), minutes/hours/days durations.
- Binding bids, race-safe (single SQL transaction), minimum increment, anti-sniping (+2 min for late bids), bid history, real-time updates.
- Server-side auction closing, 24-hour payment window, order flow (paid, received, shipped, delivered), automatic non-payment case after 24h, buyer/seller reports.
- Public history of closed auctions with closing prices.
- **Admin panel**: only Facebook IDs listed in `ADMIN_FB_IDS` can see it. The server returns 404 on admin routes for everyone else, so it is hidden and not just a hidden button. The admin blocks the defaulting buyer or seller, with a required note and an audit log.

## Going live

1. **Hosting.** Any host that runs Node with a persistent disk: Render, Railway, Fly.io, or a small VPS. Use the included `Dockerfile`, mount a volume at `/data`, and serve over HTTPS (Facebook requires it).
2. **Facebook.** Create an app at developers.facebook.com, add *Facebook Login*, add your domain to the allowed domains and redirect settings, and put the App ID and Secret in `FB_APP_ID` / `FB_APP_SECRET`. The server checks every token with Facebook's `debug_token`, so tokens from other apps are rejected. Public profile login needs no app review.
3. **Your admin ID.** Sign in once, then find your Facebook user ID (for example from the Graph API Explorer: `me?fields=id`). Set `ADMIN_FB_IDS=<your id>` and restart.
4. **SMS.** Create a Twilio account and set `TWILIO_SID`, `TWILIO_TOKEN`, `TWILIO_FROM`. Check delivery to Israeli numbers on your plan.
5. **Secrets.** Set a long random `JWT_SECRET`. Never run with `DEV_AUTH=1` in production.
6. **Backups.** Back up `DB_FILE` daily (SQLite file, WAL mode).

## Before real users (not built yet)

- **Payments.** Payment is confirmed manually between buyer and seller. For buyer protection add escrow through a marketplace payment provider (Stripe Connect or a local one); then non-payment cases mostly disappear.
- **Legal.** Have a lawyer review the Terms of Service (binding bids, 24-hour payment, blocking) and write a privacy policy. Facebook requires a privacy policy URL.
- **Scale.** One server process handles the MVP. For more traffic move to Postgres (the SQL is plain) and Redis pub/sub for WebSockets, and move photos to S3 or R2.
- **Missing features:** email/push notifications, listing edits, user ratings, search, proxy bidding, automated counterfeit review.
- **Last-sale prices.** eBay's sold-price data needs approved API access; add it as a server route that caches results, then show it in the auction page.
