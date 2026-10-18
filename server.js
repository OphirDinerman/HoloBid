'use strict';
const express = require('express'), http = require('http'), crypto = require('crypto'), path = require('path'), fs = require('fs');
const jwt = require('jsonwebtoken'), Database = require('better-sqlite3'), { WebSocketServer } = require('ws'), webpush = require('web-push');

const env = process.env;
const DEV = env.DEV_AUTH === '1';
const SECRET = env.JWT_SECRET || crypto.randomBytes(32).toString('hex'); // set JWT_SECRET in production
const ADMINS = (env.ADMIN_FB_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
if (!DEV && !env.JWT_SECRET) console.warn('WARNING: JWT_SECRET is not set. Sessions will reset on every restart.');

const db = new Database(env.DB_FILE || 'holobid.db');
console.log('Database file: ' + path.resolve(env.DB_FILE || 'holobid.db') + ((env.DB_FILE || '').startsWith('/data/') ? ' (persistent disk path)' : ' (WARNING: if this is not on a persistent disk, data is lost on every deploy)'));
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, fb_id TEXT UNIQUE NOT NULL, name TEXT NOT NULL, phone TEXT UNIQUE, phone_verified INTEGER DEFAULT 0, tos_at INTEGER, tos_version TEXT, blocked INTEGER DEFAULT 0, created INTEGER);
CREATE TABLE IF NOT EXISTS tos_acceptances(id INTEGER PRIMARY KEY, user_id INTEGER, version TEXT, at INTEGER, ip TEXT, ua TEXT);
CREATE TABLE IF NOT EXISTS otps(user_id INTEGER PRIMARY KEY, phone TEXT, code TEXT, expires INTEGER, attempts INTEGER DEFAULT 0, sent_at INTEGER, sent_count INTEGER DEFAULT 0, window_start INTEGER);
CREATE TABLE IF NOT EXISTS auctions(id INTEGER PRIMARY KEY, seller_id INTEGER, type TEXT, title TEXT, set_name TEXT, cond TEXT, info TEXT, start_price INTEGER, inc INTEGER, ship_fee INTEGER, ship_by TEXT, ref_price INTEGER, end_at INTEGER, status TEXT DEFAULT 'live', current_price INTEGER, leader_id INTEGER, bid_count INTEGER DEFAULT 0, img_count INTEGER DEFAULT 0, created INTEGER);
CREATE TABLE IF NOT EXISTS images(auction_id INTEGER, idx INTEGER, mime TEXT, data BLOB, PRIMARY KEY(auction_id, idx));
CREATE TABLE IF NOT EXISTS bids(id INTEGER PRIMARY KEY, auction_id INTEGER, bidder_id INTEGER, amount INTEGER, created INTEGER);
CREATE INDEX IF NOT EXISTS bids_a ON bids(auction_id);
CREATE TABLE IF NOT EXISTS orders(id INTEGER PRIMARY KEY, auction_id INTEGER UNIQUE, buyer_id INTEGER, seller_id INTEGER, price INTEGER, ship_fee INTEGER, ship_by TEXT, status TEXT, due_at INTEGER, created INTEGER);
CREATE TABLE IF NOT EXISTS cases(id INTEGER PRIMARY KEY, order_id INTEGER, reported_id INTEGER, opened_by INTEGER, why TEXT, status TEXT DEFAULT 'open', note TEXT, resolved_by INTEGER, created INTEGER);
CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY, actor INTEGER, action TEXT, detail TEXT, ts INTEGER);
CREATE TABLE IF NOT EXISTS notifications(id INTEGER PRIMARY KEY, user_id INTEGER, type TEXT, auction_id INTEGER, title TEXT, amount INTEGER, created INTEGER, read INTEGER DEFAULT 0);
CREATE INDEX IF NOT EXISTS notif_u ON notifications(user_id);
CREATE TABLE IF NOT EXISTS push_subs(endpoint TEXT PRIMARY KEY, user_id INTEGER, p256dh TEXT, auth TEXT, created INTEGER);
CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v TEXT);
`);
const addCol = (t, c, d) => { if (!db.prepare(`PRAGMA table_info(${t})`).all().some(x => x.name === c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${d}`); };
addCol('auctions', 'city', 'TEXT'); addCol('auctions', 'leader_pickup', 'INTEGER DEFAULT 0'); addCol('bids', 'pickup', 'INTEGER DEFAULT 0'); addCol('orders', 'pickup', 'INTEGER DEFAULT 0');
db.exec(`
CREATE TABLE IF NOT EXISTS avatars(user_id INTEGER PRIMARY KEY, mime TEXT, data BLOB);
CREATE TABLE IF NOT EXISTS suggestions(id INTEGER PRIMARY KEY, user_id INTEGER, text TEXT, created INTEGER);
CREATE TABLE IF NOT EXISTS suggestion_votes(sid INTEGER, user_id INTEGER, v INTEGER, PRIMARY KEY(sid, user_id));
`);
db.exec(`
CREATE TRIGGER IF NOT EXISTS no_delete_auctions BEFORE DELETE ON auctions BEGIN SELECT RAISE(ABORT,'Auctions cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS no_delete_bids BEFORE DELETE ON bids BEGIN SELECT RAISE(ABORT,'Bids cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS no_delete_images BEFORE DELETE ON images BEGIN SELECT RAISE(ABORT,'Photos cannot be deleted'); END;
`);
addCol('auctions', 'pickup_note', 'TEXT'); addCol('users', 'avatar_key', 'TEXT');
addCol('users', 'email', 'TEXT'); addCol('users', 'home_city', 'TEXT'); addCol('users', 'notif_outbid', 'INTEGER DEFAULT 1'); addCol('users', 'notif_won', 'INTEGER DEFAULT 1'); addCol('users', 'notif_sold', 'INTEGER DEFAULT 1'); addCol('users', 'lang', "TEXT DEFAULT 'en'"); addCol('users', 'fb_handle', 'TEXT');

const now = () => Date.now();
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const mask = n => n[0] + '***' + n.slice(-1);
const adminEmails = () => (env.ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const isAdmin = u => ADMINS.includes(u.fb_id) || (!!u.email && adminEmails().includes(String(u.email).toLowerCase()));
const TOS_VERSION = '1.2'; // 1.2: phone and city are typed by the user (not verified) and shared with the other party after an auction
const pub = u => ({ id: u.id, name: u.name, phone_verified: !!u.phone_verified, tos: u.tos_version === TOS_VERSION, blocked: !!u.blocked, admin: isAdmin(u), phone: u.phone || null, city: u.home_city || null, av: u.avatar_key ? '/api/avatar/' + u.avatar_key : null });
const fail = (res, code, error) => res.status(code).json({ error });

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '12mb' }));
app.use((req, res, next) => {
  if (req.secure) res.set('Strict-Transport-Security', 'max-age=31536000');
  res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()' });
  next();
});

// Small in-memory rate limiter (use Redis if you run several servers).
const hits = new Map();
const limit = (max, ms) => (req, res, next) => {
  if (env.NO_RATE_LIMIT === '1') return next(); // tests only
  const k = req.ip + req.path, t = now(), a = (hits.get(k) || []).filter(x => t - x < ms);
  if (a.length >= max) return fail(res, 429, 'Too many requests. Try again later.');
  a.push(t); hits.set(k, a); next();
};
setInterval(() => { const t = now(); for (const [k, a] of hits) if (!a.some(x => t - x < 3600000)) hits.delete(k); }, 600000).unref();

const auth = (req, res, next) => {
  try {
    const p = jwt.verify((req.headers.authorization || '').replace('Bearer ', ''), SECRET);
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(p.sub);
    if (!u || u.fb_id.startsWith('deleted:')) throw 0; // deleted accounts can no longer use their old token
    req.user = u; next();
  } catch { fail(res, 401, 'Please sign in.'); }
};
const ready = (msg = 'Blocked accounts cannot do this.') => (req, res, next) => {
  const u = req.user;
  if (u.blocked) return fail(res, 403, msg);
  if (!u.phone_verified || u.tos_version !== TOS_VERSION) return fail(res, 403, 'Finish sign-up first.');
  next();
};
const adminOnly = (req, res, next) => isAdmin(req.user) ? next() : fail(res, 404, 'Not found'); // hidden from everyone else

// ---------- Notifications (in-app + Web Push) ----------
function initVapid() {
  let pub = env.VAPID_PUBLIC, priv = env.VAPID_PRIVATE;
  if (!pub) { // generated once and kept in the database so subscriptions survive restarts
    const row = db.prepare("SELECT v FROM kv WHERE k='vapid'").get();
    if (row) ({ pub, priv } = JSON.parse(row.v));
    else { const k = webpush.generateVAPIDKeys(); pub = k.publicKey; priv = k.privateKey; db.prepare("INSERT INTO kv VALUES('vapid',?)").run(JSON.stringify({ pub, priv })); }
  }
  webpush.setVapidDetails(env.VAPID_SUBJECT || 'mailto:admin@example.com', pub, priv);
  return pub;
}
const VAPID_PUB = initVapid();
let pushSender = (sub, payload) => webpush.sendNotification(sub, JSON.stringify(payload), { TTL: 3600 });
async function pushUser(uid, payload) {
  for (const s of db.prepare('SELECT * FROM push_subs WHERE user_id=?').all(uid)) {
    try { await pushSender({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload); }
    catch (e) { if (e.statusCode === 404 || e.statusCode === 410) db.prepare('DELETE FROM push_subs WHERE endpoint=?').run(s.endpoint); else console.error('push failed', e.statusCode || e.message); }
  }
}
const shekel = n => '₪' + Number(n).toLocaleString('en-US');
const NT = {
  en: { title: { outbid: 'You were outbid', won: 'You won!', sold: 'Your item sold!' }, body: { outbid: (t, a) => `You were outbid on "${t}". New highest bid: ${shekel(a)}.`, won: (t, a) => `You won "${t}" for ${shekel(a)}. Pay within 24 hours.`, sold: (t, a) => `"${t}" sold for ${shekel(a)}. The buyer has 24 hours to pay.` } },
  he: { title: { outbid: 'הוצעה הצעה גבוהה משלך', won: 'זכית במכרז!', sold: 'הפריט שלך נמכר!' }, body: { outbid: (t, a) => `הוצעה הצעה גבוהה יותר על "${t}". ההצעה הגבוהה ביותר: ${shekel(a)}.`, won: (t, a) => `זכיתם ב"${t}" ב-${shekel(a)}. התשלום נדרש בתוך 24 שעות.`, sold: (t, a) => `"${t}" נמכר ב-${shekel(a)}. לקונה יש 24 שעות לשלם.` } }
};
// Saves the notification (if the user has this type switched on). Call deliver() after the transaction commits.
function addNotif(uid, type, aid, title, amount) {
  const u = db.prepare('SELECT notif_outbid, notif_won, notif_sold, lang FROM users WHERE id=?').get(uid);
  if (!u) return null;
  const on = type === 'outbid' ? u.notif_outbid : type === 'won' ? u.notif_won : u.notif_sold;
  if (!on) return null;
  const r = db.prepare('INSERT INTO notifications(user_id,type,auction_id,title,amount,created,read) VALUES(?,?,?,?,?,?,0)').run(uid, type, aid, title, amount, now());
  return { id: r.lastInsertRowid, user_id: uid, type, title, amount, lang: u.lang };
}
function deliver(n) {
  if (!n) return;
  const L = NT[n.lang] || NT.en;
  pushUser(n.user_id, { title: L.title[n.type], body: L.body[n.type](n.title, n.amount), tag: n.type + n.id, url: '/' }).catch(() => {});
}

// ---------- Auth ----------
app.get('/api/config', (q, r) => r.json({ googleClientId: env.GOOGLE_CLIENT_ID || null, dev: DEV, vapid: VAPID_PUB }));
const token = u => jwt.sign({ sub: u.id }, SECRET, { expiresIn: '30d' });

async function googleProfile(idToken) {
  if (!env.GOOGLE_CLIENT_ID) throw new Error('Google sign-in is not configured'); // fail closed: never accept tokens we cannot tie to our own client id
  const j = await (await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken))).json(); // Google checks the signature
  if (!j.sub || j.aud !== env.GOOGLE_CLIENT_ID) throw new Error('token not for this app');
  if (j.iss !== 'accounts.google.com' && j.iss !== 'https://accounts.google.com') throw new Error('bad issuer');
  if (!(+j.exp * 1000 > Date.now())) throw new Error('expired');
  if (String(j.email_verified) !== 'true' || !j.email) throw new Error('email not verified');
  const email = String(j.email).toLowerCase();
  return { id: 'g:' + j.sub, name: String(j.name || email.split('@')[0]).trim().slice(0, 40), email };
}
app.post('/api/auth/google', limit(30, 600000), async (req, res) => {
  try {
    let p;
    if (req.body.dev) {
      if (!DEV) return fail(res, 403, 'Dev login is off.');
      const n = String(req.body.dev).trim().slice(0, 40);
      if (!n) return fail(res, 400, 'Enter a name.');
      p = { id: 'dev:' + n.toLowerCase().replace(/\s+/g, '-'), name: n };
    } else p = await googleProfile(req.body.credential);
    let u = db.prepare('SELECT * FROM users WHERE fb_id=?').get(p.id);
    if (!u) {
      const i = db.prepare('INSERT INTO users(fb_id,name,email,created) VALUES(?,?,?,?)').run(p.id, p.name, p.email || null, now());
      u = db.prepare('SELECT * FROM users WHERE id=?').get(i.lastInsertRowid);
    } else if (p.email && u.email !== p.email) { db.prepare('UPDATE users SET email=? WHERE id=?').run(p.email, u.id); u.email = p.email; }
    res.json({ token: token(u), user: pub(u) });
  } catch { fail(res, 401, 'Google sign-in failed.'); }
});

const normPhone = s => {
  let d = String(s || '').replace(/[^\d+]/g, '');
  if (d.startsWith('00')) d = '+' + d.slice(2);
  if (!d.startsWith('+')) d = (env.DEFAULT_CC || '+972') + d.replace(/^0/, '');
  return /^\+\d{9,15}$/.test(d) ? d : null;
};
// Sign-up details: city of residence and phone number. They are typed by the user (not verified) and shown only to the other party of an auction.
app.post('/api/auth/details', auth, limit(30, 3600000), (req, res) => {
  const ph = normPhone((req.body || {}).phone);
  if (!ph) return fail(res, 400, 'Enter a valid mobile number.');
  const city = String((req.body || {}).city || '').trim().replace(/\s+/g, ' ').slice(0, 40);
  if (city.length < 2) return fail(res, 400, 'Enter your city of residence.');
  try { db.prepare('UPDATE users SET phone=?, home_city=?, phone_verified=1 WHERE id=?').run(ph, city, req.user.id); } // phone_verified now means "details completed"
  catch { return fail(res, 409, 'This number is already used by another account.'); }
  res.json({ ok: true });
});
app.post('/api/auth/tos', auth, (req, res) => {
  if (!req.user.phone_verified) return fail(res, 403, 'Finish sign-up first.');
  const t = now();
  db.prepare('UPDATE users SET tos_at=?, tos_version=? WHERE id=?').run(t, TOS_VERSION, req.user.id);
  db.prepare('INSERT INTO tos_acceptances(user_id,version,at,ip,ua) VALUES(?,?,?,?,?)').run(req.user.id, TOS_VERSION, t, req.ip, String(req.headers['user-agent'] || '').slice(0, 200));
  res.json({ ok: true });
});

// ---------- Reading data ----------
function ser(a, uid) {
  const bids = db.prepare('SELECT b.amount, b.created, u.name FROM bids b JOIN users u ON u.id=b.bidder_id WHERE b.auction_id=? ORDER BY b.id DESC LIMIT 200').all(a.id)
    .reverse().map(b => ({ u: mask(b.name), a: b.amount, t: b.created }));
  return { id: a.id, type: a.type, title: a.title, set: a.set_name, cond: a.cond, info: a.info, ship: a.ship_by === 'seller' ? 0 : a.ship_fee, by: a.ship_by === 'pickup' ? 'pickup' : 'both', city: a.city || '', pn: a.pickup_note || '', start: a.start_price, inc: a.inc, end: a.end_at, bids, imgs: Array.from({ length: a.img_count }, (_, i) => `/api/img/${a.id}/${i}`), mine: a.seller_id === uid, lead: a.leader_id === uid };
}
app.get('/api/state', auth, (req, res) => {
  const u = req.user;
  const out = {
    now: now(), user: pub(u),
    auctions: db.prepare("SELECT * FROM auctions WHERE status='live' ORDER BY end_at").all().map(a => ser(a, u.id)),
    past: db.prepare("SELECT id,type,title,set_name,current_price,bid_count,end_at,(SELECT COUNT(*) FROM images i WHERE i.auction_id=auctions.id) n FROM auctions WHERE status='closed' ORDER BY end_at DESC LIMIT 100").all()
      .map(a => ({ id: a.id, n: a.n, type: a.type, title: a.title, set: a.set_name, price: a.bid_count ? a.current_price : 0, bids: a.bid_count, date: new Date(a.end_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) })),
    myBids: db.prepare('SELECT a.title, b.amount amt, b.created t FROM bids b JOIN auctions a ON a.id=b.auction_id WHERE b.bidder_id=? ORDER BY b.id DESC LIMIT 100').all(u.id).reverse(),
    orders: db.prepare('SELECT o.*, a.title, a.city, bu.name bname, su.name sname, bu.phone bphone, bu.home_city bcity, bu.avatar_key bav, a.pickup_note pnote, su.phone sphone, su.home_city scity, su.avatar_key sav FROM orders o JOIN auctions a ON a.id=o.auction_id JOIN users bu ON bu.id=o.buyer_id JOIN users su ON su.id=o.seller_id WHERE o.buyer_id=? OR o.seller_id=? ORDER BY o.id DESC').all(u.id, u.id)
      .map(o => ({ id: o.id, aid: o.auction_id, title: o.title, buyer: o.bname, seller: o.sname, price: o.price, ship: o.ship_fee, by: o.ship_by === 'pickup' ? 'pickup' : 'both', pickup: !!o.pickup, other: o.buyer_id === u.id ? { name: o.sname, phone: o.sphone, city: o.scity, av: o.sav ? '/api/avatar/' + o.sav : null } : { name: o.bname, phone: o.bphone, city: o.bcity, av: o.bav ? '/api/avatar/' + o.bav : null }, city: o.city || '', pn: o.pnote || '', status: o.status, due: o.due_at, role: o.buyer_id === u.id ? 'buyer' : 'seller' })).reverse()
  };
  out.myListings = db.prepare('SELECT a.id,a.type,a.title,a.status,a.current_price,a.bid_count,a.end_at,a.img_count,o.status ostatus FROM auctions a LEFT JOIN orders o ON o.auction_id=a.id WHERE a.seller_id=? ORDER BY a.id DESC LIMIT 100').all(u.id)
    .map(a => ({ id: a.id, type: a.type, title: a.title, status: a.status === 'live' ? 'live' : a.status === 'cancelled' ? 'cancelled' : a.bid_count ? 'sold' : 'unsold', price: a.status === 'live' || a.bid_count ? a.current_price : 0, bids: a.bid_count, end: a.end_at, img: a.img_count ? `/api/img/${a.id}/0` : null, order: a.ostatus || null }));
  out.notifs = db.prepare('SELECT id,type,auction_id aid,title,amount,created t,read FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 50').all(u.id).map(n => ({ ...n, read: !!n.read }));
  out.prefs = { outbid: !!u.notif_outbid, won: !!u.notif_won, sold: !!u.notif_sold, lang: u.lang || 'en' };
  if (isAdmin(u)) {
    out.cases = db.prepare(`SELECT c.*, a.title, bu.name bname, su.name sname, ru.name rname, o.price, o.buyer_id FROM cases c JOIN orders o ON o.id=c.order_id JOIN auctions a ON a.id=o.auction_id
      JOIN users bu ON bu.id=o.buyer_id JOIN users su ON su.id=o.seller_id JOIN users ru ON ru.id=c.reported_id ORDER BY c.id DESC`).all()
      .map(c => ({ id: c.id, item: c.title, buyer: c.bname, seller: c.sname, amt: c.price, why: c.why, party: c.reported_id === c.buyer_id ? 'buyer' : 'seller', status: c.status === 'open' ? 'open' : c.status === 'blocked' ? 'blocked: ' + c.rname : 'dismissed', note: c.note }));
    out.blocked = db.prepare('SELECT name FROM users WHERE blocked=1').all().map(r => r.name);
  }
  res.json(out);
});
app.get('/api/img/:a/:i', (req, res) => {
  const r = db.prepare('SELECT mime,data FROM images WHERE auction_id=? AND idx=?').get(+req.params.a, +req.params.i);
  if (!r) return res.sendStatus(404);
  res.set('Cache-Control', 'public, max-age=31536000, immutable').type(r.mime).send(r.data);
});

// ---------- Listing and bidding ----------
app.post('/api/auctions', auth, ready('Blocked accounts cannot list.'), (req, res) => {
  const b = req.body || {}, u = req.user;
  const title = String(b.title || '').trim().slice(0, 120), st = Math.floor(+b.start), sh = Math.floor(+b.ship), hrs = +b.hours;
  if (title.length < 3) return fail(res, 400, 'Add a title.');
  if (!(st >= 1 && st <= 1e6)) return fail(res, 400, 'Set a starting price.');
  const mode = ['pickup', 'both'].includes(b.by) ? b.by : null; // pickup only, or pickup + shipping at the seller's price
  if (!mode) return fail(res, 400, 'Choose how the buyer can get the item.');
  if (mode === 'both' && (b.ship === '' || b.ship == null || !(sh >= 0 && sh <= 1e4))) return fail(res, 400, 'Set the shipping cost (0 if free).');
  const city = String(b.city || '').trim().slice(0, 60);
  if (city.length < 2) return fail(res, 400, 'Enter the pickup city.');
  if (!['card', 'booster'].includes(b.type)) return fail(res, 400, 'Pick an item type.');
  if (!(hrs >= 0.5 && hrs <= 168)) return fail(res, 400, 'Pick a duration.');
  const imgs = Array.isArray(b.imgs) ? b.imgs.slice(0, 10) : [];
  if (imgs.length < 2) return fail(res, 400, 'Add at least 2 photos.');
  let parsed;
  try {
    parsed = imgs.map(s => {
      const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(s));
      if (!m) throw new Error('Photos must be JPEG, PNG or WebP.');
      const buf = Buffer.from(m[2], 'base64');
      if (buf.length > 600000) throw new Error('A photo is too large.');
      return { mime: m[1], buf };
    });
  } catch (e) { return fail(res, 400, e.message); }
  if (db.prepare("SELECT COUNT(*) c FROM auctions WHERE seller_id=? AND status='live'").get(u.id).c >= 5) return fail(res, 400, 'You can have at most 5 live listings.');
  const id = db.transaction(() => {
    const t = now();
    const r = db.prepare('INSERT INTO auctions(seller_id,type,title,set_name,cond,info,start_price,inc,ship_fee,ship_by,ref_price,end_at,current_price,img_count,created,city) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(u.id, b.type, title, String(b.set || '').trim().slice(0, 100) || 'Unknown set', String(b.cond || '').trim().slice(0, 60) || 'Not stated', String(b.info || '').trim().slice(0, 2000),
        st, st >= 500 ? 25 : 10, mode === 'pickup' ? 0 : sh, mode, 0, t + hrs * 3600000, st, parsed.length, t, city);
    db.prepare('UPDATE auctions SET pickup_note=? WHERE id=?').run(String(b.pickupNote || '').trim().replace(/\s+/g, ' ').slice(0, 120) || null, r.lastInsertRowid);
    parsed.forEach((p, i) => db.prepare('INSERT INTO images VALUES(?,?,?,?)').run(r.lastInsertRowid, i, p.mime, p.buf));
    return r.lastInsertRowid;
  })();
  broadcast();
  res.json({ id });
});

const placeBid = db.transaction((uid, aid, amount, pickup) => {
  const a = db.prepare('SELECT * FROM auctions WHERE id=?').get(aid), t = now();
  if (!a || a.status !== 'live' || a.end_at <= t) return { code: 409, err: 'Auction closed.' };
  if (a.seller_id === uid) return { code: 403, err: 'You cannot bid on your own listing.' };
  const min = a.bid_count ? a.current_price + a.inc : a.start_price;
  if (!(amount >= min)) return { code: 409, err: `Bid must be at least ₪${min.toLocaleString('en-US')}.` };
  const pk = a.ship_by === 'pickup' || pickup ? 1 : 0; // pickup-only items are always picked up; otherwise the buyer chooses
  db.prepare('INSERT INTO bids(auction_id,bidder_id,amount,created,pickup) VALUES(?,?,?,?,?)').run(aid, uid, amount, t, pk);
  const ext = a.end_at - t < 120000; // anti-sniping: late bid adds 2 minutes
  db.prepare('UPDATE auctions SET current_price=?, leader_id=?, leader_pickup=?, bid_count=bid_count+1, end_at=? WHERE id=?').run(amount, uid, pk, ext ? a.end_at + 120000 : a.end_at, aid);
  const notif = a.leader_id && a.leader_id !== uid ? addNotif(a.leader_id, 'outbid', aid, a.title, amount) : null; // tell the person who was just outbid
  return { ok: true, ext, notif };
});
app.post('/api/auctions/:id/bids', auth, ready('Blocked accounts cannot bid.'), limit(60, 60000), (req, res) => {
  const amount = Math.floor(+req.body.amount);
  if (!(amount >= 1 && amount <= 1e7)) return fail(res, 400, 'Enter a valid bid.');
  const r = placeBid(req.user.id, +req.params.id, amount, !!req.body.pickup);
  if (!r.ok) return fail(res, r.code, r.err);
  broadcast();
  deliver(r.notif);
  res.json({ ok: true, ext: r.ext });
});

// ---------- Orders and non-payment cases ----------
const OPS = {
  paid: { role: 'buyer', from: 'awaiting_payment', to: 'payment_claimed' },
  recv: { role: 'seller', from: 'payment_claimed', to: 'paid' },
  ship: { role: 'seller', from: 'paid', to: 'shipped' },
  got: { role: 'buyer', from: 'shipped', to: 'completed' },
  norecv: { role: 'seller', from: 'payment_claimed', to: 'review', why: 'Seller says the payment was not received', rep: 'buyer_id' },
  noship: { role: 'buyer', from: 'paid', to: 'review', why: 'Payment confirmed, seller has not shipped', rep: 'seller_id' }
};
app.post('/api/orders/:id/:op', auth, ready(), (req, res) => {
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(+req.params.id), p = OPS[req.params.op];
  if (!o || !p) return fail(res, 404, 'Not found');
  const role = o.buyer_id === req.user.id ? 'buyer' : o.seller_id === req.user.id ? 'seller' : null;
  if (role !== p.role) return fail(res, 403, 'Not allowed.');
  if (o.status !== p.from) return fail(res, 409, 'This order changed. Refresh.');
  db.transaction(() => {
    db.prepare('UPDATE orders SET status=? WHERE id=?').run(p.to, o.id);
    if (p.why) db.prepare('INSERT INTO cases(order_id,reported_id,opened_by,why,created) VALUES(?,?,?,?,?)').run(o.id, o[p.rep], req.user.id, p.why, now());
  })();
  broadcast();
  res.json({ ok: true });
});

// Closes ended auctions, creates orders (24h payment window) and opens a case for unpaid orders.
const sweepTx = db.transaction(() => {
  const t = now(); let changed = false; const notifs = [];
  for (const a of db.prepare("SELECT * FROM auctions WHERE status='live' AND end_at<=?").all(t)) {
    changed = true;
    db.prepare("UPDATE auctions SET status='closed' WHERE id=?").run(a.id);
    if (a.bid_count) db.prepare('INSERT INTO orders(auction_id,buyer_id,seller_id,price,ship_fee,ship_by,status,due_at,created,pickup) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(a.id, a.leader_id, a.seller_id, a.current_price, a.ship_fee, a.ship_by, 'awaiting_payment', a.end_at + 864e5, t, a.leader_pickup || 0);
    if (a.bid_count) { notifs.push(addNotif(a.leader_id, 'won', a.id, a.title, a.current_price)); notifs.push(addNotif(a.seller_id, 'sold', a.id, a.title, a.current_price)); }
  }
  for (const o of db.prepare("SELECT * FROM orders WHERE status='awaiting_payment' AND due_at<=?").all(t)) {
    changed = true;
    db.prepare("UPDATE orders SET status='overdue' WHERE id=?").run(o.id);
    db.prepare('INSERT INTO cases(order_id,reported_id,opened_by,why,created) VALUES(?,?,?,?,?)').run(o.id, o.buyer_id, null, 'Winner did not pay within 24 hours', t);
  }
  return { changed, notifs };
});
function sweep() { const r = sweepTx(); if (r.changed) { broadcast(); r.notifs.forEach(deliver); } }

// ---------- Notification settings and device (push) subscriptions ----------
app.post('/api/prefs', auth, (req, res) => {
  const b = req.body || {}, u = req.user;
  db.prepare('UPDATE users SET notif_outbid=?, notif_won=?, notif_sold=?, lang=? WHERE id=?').run(
    b.outbid === undefined ? u.notif_outbid : (b.outbid ? 1 : 0), b.won === undefined ? u.notif_won : (b.won ? 1 : 0), b.sold === undefined ? u.notif_sold : (b.sold ? 1 : 0), ['en', 'he'].includes(b.lang) ? b.lang : u.lang, u.id);
  res.json({ ok: true });
});
app.post('/api/notifications/read', auth, (req, res) => { db.prepare('UPDATE notifications SET read=1 WHERE user_id=?').run(req.user.id); res.json({ ok: true }); });
app.post('/api/push/subscribe', auth, limit(30, 3600000), (req, res) => {
  const b = req.body || {}, k = b.keys || {};
  if (!/^https:\/\//.test(String(b.endpoint || '')) || !k.p256dh || !k.auth) return fail(res, 400, 'Invalid subscription.');
  db.prepare('INSERT OR REPLACE INTO push_subs(endpoint,user_id,p256dh,auth,created) VALUES(?,?,?,?,?)').run(b.endpoint, req.user.id, k.p256dh, k.auth, now());
  res.json({ ok: true });
});
app.post('/api/push/unsubscribe', auth, (req, res) => { db.prepare('DELETE FROM push_subs WHERE endpoint=? AND user_id=?').run(String((req.body || {}).endpoint || ''), req.user.id); res.json({ ok: true }); });

// ---------- Admin (only users whose email is in ADMIN_EMAILS) ----------
app.post('/api/admin/cases/:id', auth, adminOnly, (req, res) => {
  const c = db.prepare('SELECT * FROM cases WHERE id=?').get(+req.params.id), note = String(req.body.note || '').trim(), act = req.body.action;
  if (!c) return fail(res, 404, 'Not found');
  if (c.status !== 'open') return fail(res, 409, 'This case is already resolved.');
  if (!['block', 'dismiss'].includes(act)) return fail(res, 400, 'Unknown action.');
  if (!note) return fail(res, 400, 'Add a resolution note first.');
  db.transaction(() => {
    db.prepare('UPDATE cases SET status=?, note=?, resolved_by=? WHERE id=?').run(act === 'block' ? 'blocked' : 'dismissed', note, req.user.id, c.id);
    db.prepare("UPDATE orders SET status='resolved' WHERE id=?").run(c.order_id);
    if (act === 'block') {
      db.prepare('UPDATE users SET blocked=1 WHERE id=?').run(c.reported_id);
      db.prepare("UPDATE auctions SET status='cancelled' WHERE seller_id=? AND status='live'").run(c.reported_id);
    }
    db.prepare('INSERT INTO audit(actor,action,detail,ts) VALUES(?,?,?,?)').run(req.user.id, act, JSON.stringify({ case: c.id, user: c.reported_id, note }), now());
  })();
  broadcast();
  res.json({ ok: true });
});

// Account deletion (also what Facebook's "data deletion" requirement points to). Personal data is erased; auction and order rows stay for the other party's records.
app.post('/api/account/delete', auth, (req, res) => {
  const u = req.user;
  if (u.blocked) return fail(res, 403, 'This account cannot be deleted.');
  if (db.prepare("SELECT 1 FROM auctions WHERE status='live' AND (seller_id=? OR leader_id=?)").get(u.id, u.id)) return fail(res, 409, 'You have live auctions. Wait until they end first.');
  if (db.prepare("SELECT 1 FROM orders WHERE (buyer_id=? OR seller_id=?) AND status NOT IN ('completed','resolved')").get(u.id, u.id)) return fail(res, 409, 'Finish your open orders first.');
  db.transaction(() => {
    db.prepare("UPDATE users SET name='Deleted user', fb_id=?, phone=NULL, home_city=NULL, phone_verified=0, fb_handle=NULL, email=NULL, avatar_key=NULL, tos_at=NULL, tos_version=NULL WHERE id=?").run('deleted:' + u.id, u.id);
    for (const t of ['push_subs', 'notifications', 'otps', 'avatars', 'suggestion_votes']) db.prepare(`DELETE FROM ${t} WHERE user_id=?`).run(u.id);
    db.prepare('DELETE FROM suggestion_votes WHERE sid IN (SELECT id FROM suggestions WHERE user_id=?)').run(u.id); db.prepare('DELETE FROM suggestions WHERE user_id=?').run(u.id);
    db.prepare('INSERT INTO audit(actor,action,detail,ts) VALUES(?,?,?,?)').run(u.id, 'delete_account', '{}', now());
  })();
  res.json({ ok: true });
});

// ---------- Profile picture ----------
app.post('/api/profile/avatar', auth, ready(), limit(20, 3600000), (req, res) => {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String((req.body || {}).img || ''));
  if (!m) return fail(res, 400, 'Photos must be JPEG, PNG or WebP.');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 250000) return fail(res, 400, 'A photo is too large.');
  const key = crypto.randomBytes(12).toString('hex'); // unguessable address: only the other party of an auction ever receives it
  db.transaction(() => { db.prepare('INSERT OR REPLACE INTO avatars VALUES(?,?,?)').run(req.user.id, m[1], buf); db.prepare('UPDATE users SET avatar_key=? WHERE id=?').run(key, req.user.id); })();
  res.json({ ok: true, av: '/api/avatar/' + key });
});
app.delete('/api/profile/avatar', auth, (req, res) => {
  db.transaction(() => { db.prepare('DELETE FROM avatars WHERE user_id=?').run(req.user.id); db.prepare('UPDATE users SET avatar_key=NULL WHERE id=?').run(req.user.id); })();
  res.json({ ok: true });
});
app.get('/api/avatar/:key', (req, res) => {
  const r = db.prepare('SELECT a.mime, a.data FROM avatars a JOIN users u ON u.id=a.user_id WHERE u.avatar_key=?').get(String(req.params.key));
  if (!r) return res.sendStatus(404);
  res.set('Cache-Control', 'public, max-age=31536000, immutable').type(r.mime).send(r.data);
});

// ---------- Suggestions for improvement (public list with like / dislike) ----------
app.get('/api/suggestions', auth, ready(), (req, res) => {
  const rows = db.prepare(`SELECT s.id, s.text, s.created, s.user_id, u.name,
      COALESCE(SUM(CASE WHEN v.v=1 THEN 1 ELSE 0 END),0) up, COALESCE(SUM(CASE WHEN v.v=-1 THEN 1 ELSE 0 END),0) down,
      (SELECT v FROM suggestion_votes WHERE sid=s.id AND user_id=?) mine
    FROM suggestions s JOIN users u ON u.id=s.user_id LEFT JOIN suggestion_votes v ON v.sid=s.id
    GROUP BY s.id ORDER BY (up-down) DESC, s.created DESC LIMIT 200`).all(req.user.id);
  res.json(rows.map(r => ({ id: r.id, text: r.text, t: r.created, by: mask(r.name), up: r.up, down: r.down, mine: r.mine || 0, own: r.user_id === req.user.id })));
});
app.post('/api/suggestions', auth, ready(), limit(30, 3600000), (req, res) => {
  const text = String((req.body || {}).text || '').trim().replace(/[ \t]+/g, ' ').slice(0, 500);
  if (text.length < 5) return fail(res, 400, 'Write at least a few words.');
  if (db.prepare('SELECT COUNT(*) c FROM suggestions WHERE user_id=? AND created>?').get(req.user.id, now() - 86400000).c >= 5) return fail(res, 429, 'You can send up to 5 suggestions per day.');
  const id = db.prepare('INSERT INTO suggestions(user_id,text,created) VALUES(?,?,?)').run(req.user.id, text, now()).lastInsertRowid;
  res.json({ ok: true, id });
});
app.post('/api/suggestions/:id/vote', auth, ready(), limit(300, 3600000), (req, res) => {
  const id = +req.params.id, v = +(req.body || {}).v;
  if (![1, -1, 0].includes(v)) return fail(res, 400, 'Not allowed.');
  if (!db.prepare('SELECT 1 FROM suggestions WHERE id=?').get(id)) return fail(res, 404, 'Not found');
  if (v === 0) db.prepare('DELETE FROM suggestion_votes WHERE sid=? AND user_id=?').run(id, req.user.id);
  else db.prepare('INSERT OR REPLACE INTO suggestion_votes VALUES(?,?,?)').run(id, req.user.id, v);
  res.json({ ok: true });
});
app.delete('/api/suggestions/:id', auth, (req, res) => {
  const id = +req.params.id, s = db.prepare('SELECT user_id FROM suggestions WHERE id=?').get(id);
  if (!s || (s.user_id !== req.user.id && !isAdmin(req.user))) return fail(res, 404, 'Not found');
  db.transaction(() => { db.prepare('DELETE FROM suggestion_votes WHERE sid=?').run(id); db.prepare('DELETE FROM suggestions WHERE id=?').run(id); if (s.user_id !== req.user.id) db.prepare('INSERT INTO audit(actor,action,detail,ts) VALUES(?,?,?,?)').run(req.user.id, 'delete_suggestion', JSON.stringify({ id }), now()); })();
  res.json({ ok: true });
});

// Web files live either flat next to server.js (what the GitHub web upload produces) or in ./public. Flat layout serves only a fixed whitelist.
const FLAT = fs.existsSync(path.join(__dirname, 'index.html'));
const WEB = FLAT ? __dirname : path.join(__dirname, 'public');
// Legal pages (templates, with the contact email filled in from CONTACT_EMAIL)
for (const pg of ['privacy', 'terms', 'data-deletion']) {
  app.get('/' + pg, (req, res) => {
    try {
      res.type('html').send(fs.readFileSync(path.join(WEB, pg + '.html'), 'utf8').replace(/\{\{EMAIL\}\}/g, env.CONTACT_EMAIL || 'contact@example.com').replace(/\{\{SITE\}\}/g, env.SITE_NAME || 'Holo Bid'));
    } catch { res.sendStatus(404); }
  });
}
// Share link: /a/<id> serves the app with Open Graph tags so WhatsApp / Facebook groups show a preview (title, price, photo)
const escH = x => String(x == null ? '' : x).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
app.get('/a/:id', (req, res, next) => {
  if (!/^\d{1,12}$/.test(req.params.id)) return next();
  let html;
  try { html = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8'); } catch { return res.sendStatus(404); }
  const a = db.prepare('SELECT id,title,set_name,cond,current_price,start_price,status,img_count,city,end_at FROM auctions WHERE id=?').get(+req.params.id);
  if (a) {
    const site = (env.SITE_URL || (req.protocol + '://' + req.get('host'))).replace(/\/$/, '');
    const live = a.status === 'live' && a.end_at > now();
    const desc = [a.set_name, a.cond, a.city ? 'Item location: ' + a.city : '', (live ? 'Current bid ' : 'Closed at ') + '\u20aa' + (a.current_price || a.start_price)].filter(Boolean).join(' | ');
    const tags = `<meta property="og:type" content="website"><meta property="og:site_name" content="${escH(env.SITE_NAME || 'Holo Bid')}"><meta property="og:title" content="${escH(a.title)}"><meta property="og:description" content="${escH(desc)}"><meta property="og:url" content="${escH(site + '/a/' + a.id)}">${a.img_count ? `<meta property="og:image" content="${escH(site + '/api/img/' + a.id + '/0')}"><meta name="twitter:card" content="summary_large_image">` : ''}`;
    html = html.replace(/<title>[^<]*<\/title>/, '<title>' + escH(a.title) + ' | Holo Bid</title>').replace('</head>', tags + '</head>');
  }
  res.set('Cache-Control', 'no-cache').type('html').send(html);
});
if (FLAT) {
  app.get(['/', '/index.html', '/sw.js', '/icon.svg', '/manifest.webmanifest'], (req, res) => res.sendFile(path.join(__dirname, req.path === '/' ? 'index.html' : req.path.slice(1))));
} else app.use(express.static(WEB));
app.use('/api', (req, res) => fail(res, 404, 'Not found'));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
function broadcast() { wss.clients.forEach(c => c.readyState === 1 && c.send('refresh')); }

if (require.main === module) {
  setInterval(() => { try { sweep(); } catch (e) { console.error('sweep failed', e); } }, 1000);
  process.on('SIGTERM', () => { server.close(() => { try { db.close(); } catch {} process.exit(0); }); });
  server.listen(+env.PORT || 3000, () => console.log('Holo Bid running on port ' + (env.PORT || 3000) + (DEV ? ' (DEV_AUTH on)' : '')));
}
module.exports = { app, server, db, sweep, setPushSender: f => { pushSender = f; } };
