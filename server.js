'use strict';
const express = require('express'), http = require('http'), crypto = require('crypto'), path = require('path');
const jwt = require('jsonwebtoken'), Database = require('better-sqlite3'), { WebSocketServer } = require('ws');

const env = process.env;
const DEV = env.DEV_AUTH === '1';
const SECRET = env.JWT_SECRET || crypto.randomBytes(32).toString('hex'); // set JWT_SECRET in production
const ADMINS = (env.ADMIN_FB_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
if (!DEV && !env.JWT_SECRET) console.warn('WARNING: JWT_SECRET is not set. Sessions will reset on every restart.');

const db = new Database(env.DB_FILE || 'holobid.db');
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
`);

const now = () => Date.now();
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const mask = n => n[0] + '***' + n.slice(-1);
const isAdmin = u => ADMINS.includes(u.fb_id);
const pub = u => ({ id: u.id, name: u.name, phone_verified: !!u.phone_verified, tos: !!u.tos_at, blocked: !!u.blocked, admin: isAdmin(u) });
const fail = (res, code, error) => res.status(code).json({ error });

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '12mb' }));

// Small in-memory rate limiter (use Redis if you run several servers).
const hits = new Map();
const limit = (max, ms) => (req, res, next) => {
  const k = req.ip + req.path, t = now(), a = (hits.get(k) || []).filter(x => t - x < ms);
  if (a.length >= max) return fail(res, 429, 'Too many requests. Try again later.');
  a.push(t); hits.set(k, a); next();
};
setInterval(() => { const t = now(); for (const [k, a] of hits) if (!a.some(x => t - x < 3600000)) hits.delete(k); }, 600000).unref();

const auth = (req, res, next) => {
  try {
    const p = jwt.verify((req.headers.authorization || '').replace('Bearer ', ''), SECRET);
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(p.sub);
    if (!u) throw 0;
    req.user = u; next();
  } catch { fail(res, 401, 'Please sign in.'); }
};
const ready = (msg = 'Blocked accounts cannot do this.') => (req, res, next) => {
  const u = req.user;
  if (u.blocked) return fail(res, 403, msg);
  if (!u.phone_verified || !u.tos_at) return fail(res, 403, 'Finish sign-up first.');
  next();
};
const adminOnly = (req, res, next) => isAdmin(req.user) ? next() : fail(res, 404, 'Not found'); // hidden from everyone else

// ---------- Auth ----------
app.get('/api/config', (q, r) => r.json({ fbAppId: env.FB_APP_ID || null, dev: DEV }));
const token = u => jwt.sign({ sub: u.id }, SECRET, { expiresIn: '30d' });

async function fbProfile(accessToken) {
  const j = await (await fetch('https://graph.facebook.com/me?fields=id,name&access_token=' + encodeURIComponent(accessToken))).json();
  if (!j.id) throw new Error('bad token');
  if (env.FB_APP_ID && env.FB_APP_SECRET) { // make sure the token was issued to OUR app
    const d = await (await fetch(`https://graph.facebook.com/debug_token?input_token=${encodeURIComponent(accessToken)}&access_token=${env.FB_APP_ID}|${env.FB_APP_SECRET}`)).json();
    if (!d.data || !d.data.is_valid || d.data.app_id !== env.FB_APP_ID) throw new Error('token not for this app');
  }
  return j;
}
app.post('/api/auth/facebook', limit(30, 600000), async (req, res) => {
  try {
    let p;
    if (req.body.dev) {
      if (!DEV) return fail(res, 403, 'Dev login is off.');
      const n = String(req.body.dev).trim().slice(0, 40);
      if (!n) return fail(res, 400, 'Enter a name.');
      p = { id: 'dev:' + n.toLowerCase().replace(/\s+/g, '-'), name: n };
    } else p = await fbProfile(req.body.accessToken);
    let u = db.prepare('SELECT * FROM users WHERE fb_id=?').get(p.id);
    if (!u) {
      const i = db.prepare('INSERT INTO users(fb_id,name,created) VALUES(?,?,?)').run(p.id, p.name, now());
      u = db.prepare('SELECT * FROM users WHERE id=?').get(i.lastInsertRowid);
    }
    res.json({ token: token(u), user: pub(u) });
  } catch { fail(res, 401, 'Facebook sign-in failed.'); }
});

const normPhone = s => {
  let d = String(s || '').replace(/[^\d+]/g, '');
  if (d.startsWith('00')) d = '+' + d.slice(2);
  if (!d.startsWith('+')) d = (env.DEFAULT_CC || '+972') + d.replace(/^0/, '');
  return /^\+\d{9,15}$/.test(d) ? d : null;
};
async function sendSms(to, body) {
  if (env.TWILIO_SID && env.TWILIO_TOKEN && env.TWILIO_FROM) {
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_SID}/Messages.json`, {
      method: 'POST',
      headers: { Authorization: 'Basic ' + Buffer.from(env.TWILIO_SID + ':' + env.TWILIO_TOKEN).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ To: to, From: env.TWILIO_FROM, Body: body })
    });
    if (!r.ok) throw new Error('sms failed');
    return {};
  }
  if (DEV) { console.log(`[dev sms] ${to}: ${body}`); return { dev: true }; }
  throw new Error('SMS is not configured');
}
app.post('/api/auth/phone/start', auth, limit(20, 3600000), async (req, res) => {
  const ph = normPhone(req.body.phone);
  if (!ph) return fail(res, 400, 'Enter a valid mobile number.');
  if (db.prepare('SELECT id FROM users WHERE phone=? AND id!=?').get(ph, req.user.id)) return fail(res, 409, 'This number is already used by another account.');
  const o = db.prepare('SELECT * FROM otps WHERE user_id=?').get(req.user.id) || {}, t = now();
  if (o.sent_at && t - o.sent_at < 60000) return fail(res, 429, 'Wait a minute before asking for a new code.');
  const inWindow = o.window_start && t - o.window_start < 3600000, count = inWindow ? o.sent_count : 0;
  if (count >= 5) return fail(res, 429, 'Too many codes requested. Try again in an hour.');
  const code = String(crypto.randomInt(100000, 1000000));
  try { var out = await sendSms(ph, `Holo Bid code: ${code}`); } catch { return fail(res, 502, 'Could not send the SMS. Try again.'); }
  db.prepare('INSERT OR REPLACE INTO otps(user_id,phone,code,expires,attempts,sent_at,sent_count,window_start) VALUES(?,?,?,?,0,?,?,?)')
    .run(req.user.id, ph, sha(code), t + 300000, t, count + 1, inWindow ? o.window_start : t);
  res.json({ ok: true, devCode: out.dev ? code : undefined });
});
app.post('/api/auth/phone/verify', auth, limit(30, 3600000), (req, res) => {
  const o = db.prepare('SELECT * FROM otps WHERE user_id=?').get(req.user.id);
  if (!o || o.expires < now()) return fail(res, 400, 'Code expired. Ask for a new one.');
  if (o.attempts >= 5) return fail(res, 429, 'Too many attempts. Ask for a new code.');
  db.prepare('UPDATE otps SET attempts=attempts+1 WHERE user_id=?').run(req.user.id);
  if (sha(String(req.body.code || '').trim()) !== o.code) return fail(res, 400, 'Wrong code.');
  try { db.prepare('UPDATE users SET phone=?, phone_verified=1 WHERE id=?').run(o.phone, req.user.id); }
  catch { return fail(res, 409, 'This number is already used by another account.'); }
  db.prepare('DELETE FROM otps WHERE user_id=?').run(req.user.id);
  res.json({ ok: true });
});
app.post('/api/auth/tos', auth, (req, res) => {
  if (!req.user.phone_verified) return fail(res, 403, 'Finish sign-up first.');
  const t = now();
  db.prepare('UPDATE users SET tos_at=?, tos_version=? WHERE id=?').run(t, '1.0', req.user.id);
  db.prepare('INSERT INTO tos_acceptances(user_id,version,at,ip,ua) VALUES(?,?,?,?,?)').run(req.user.id, '1.0', t, req.ip, String(req.headers['user-agent'] || '').slice(0, 200));
  res.json({ ok: true });
});

// ---------- Reading data ----------
function ser(a, uid) {
  const bids = db.prepare('SELECT b.amount, b.created, u.name FROM bids b JOIN users u ON u.id=b.bidder_id WHERE b.auction_id=? ORDER BY b.id DESC LIMIT 200').all(a.id)
    .reverse().map(b => ({ u: mask(b.name), a: b.amount, t: b.created }));
  return { id: a.id, type: a.type, title: a.title, set: a.set_name, cond: a.cond, info: a.info, ship: a.ship_fee, by: a.ship_by, start: a.start_price, inc: a.inc, ref: a.ref_price, end: a.end_at, bids, imgs: Array.from({ length: a.img_count }, (_, i) => `/api/img/${a.id}/${i}`), mine: a.seller_id === uid };
}
app.get('/api/state', auth, (req, res) => {
  const u = req.user;
  const out = {
    now: now(), user: pub(u),
    auctions: db.prepare("SELECT * FROM auctions WHERE status='live' ORDER BY end_at").all().map(a => ser(a, u.id)),
    past: db.prepare("SELECT type,title,set_name,current_price,bid_count,end_at FROM auctions WHERE status='closed' ORDER BY end_at DESC LIMIT 100").all()
      .map(a => ({ type: a.type, title: a.title, set: a.set_name, price: a.bid_count ? a.current_price : 0, bids: a.bid_count, date: new Date(a.end_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) })),
    myBids: db.prepare('SELECT a.title, b.amount amt, b.created t FROM bids b JOIN auctions a ON a.id=b.auction_id WHERE b.bidder_id=? ORDER BY b.id DESC LIMIT 100').all(u.id).reverse(),
    orders: db.prepare('SELECT o.*, a.title, bu.name bname, su.name sname FROM orders o JOIN auctions a ON a.id=o.auction_id JOIN users bu ON bu.id=o.buyer_id JOIN users su ON su.id=o.seller_id WHERE o.buyer_id=? OR o.seller_id=? ORDER BY o.id DESC').all(u.id, u.id)
      .map(o => ({ id: o.id, title: o.title, buyer: o.bname, seller: o.sname, price: o.price, ship: o.ship_fee, by: o.ship_by, status: o.status, due: o.due_at, role: o.buyer_id === u.id ? 'buyer' : 'seller' })).reverse()
  };
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
  if (b.ship === '' || b.ship == null || !(sh >= 0 && sh <= 1e4)) return fail(res, 400, 'Set the shipping cost (0 if free).');
  if (!['card', 'booster'].includes(b.type)) return fail(res, 400, 'Pick an item type.');
  if (!(hrs >= 0.5 && hrs <= 168)) return fail(res, 400, 'Pick a duration.');
  const imgs = Array.isArray(b.imgs) ? b.imgs.slice(0, 10) : [];
  if (imgs.length < 3) return fail(res, 400, 'Add at least 3 photos.');
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
    const r = db.prepare('INSERT INTO auctions(seller_id,type,title,set_name,cond,info,start_price,inc,ship_fee,ship_by,ref_price,end_at,current_price,img_count,created) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(u.id, b.type, title, String(b.set || '').trim().slice(0, 100) || 'Unknown set', String(b.cond || '').trim().slice(0, 60) || 'Not stated', String(b.info || '').trim().slice(0, 2000),
        st, st >= 500 ? 25 : 10, sh, b.by === 'seller' ? 'seller' : 'buyer', Math.max(0, Math.floor(+b.ref || 0)), t + hrs * 3600000, st, parsed.length, t);
    parsed.forEach((p, i) => db.prepare('INSERT INTO images VALUES(?,?,?,?)').run(r.lastInsertRowid, i, p.mime, p.buf));
    return r.lastInsertRowid;
  })();
  broadcast();
  res.json({ id });
});

const placeBid = db.transaction((uid, aid, amount) => {
  const a = db.prepare('SELECT * FROM auctions WHERE id=?').get(aid), t = now();
  if (!a || a.status !== 'live' || a.end_at <= t) return { code: 409, err: 'Auction closed.' };
  if (a.seller_id === uid) return { code: 403, err: 'You cannot bid on your own listing.' };
  const min = a.bid_count ? a.current_price + a.inc : a.start_price;
  if (!(amount >= min)) return { code: 409, err: `Bid must be at least ₪${min.toLocaleString('en-US')}.` };
  db.prepare('INSERT INTO bids(auction_id,bidder_id,amount,created) VALUES(?,?,?,?)').run(aid, uid, amount, t);
  const ext = a.end_at - t < 120000; // anti-sniping: late bid adds 2 minutes
  db.prepare('UPDATE auctions SET current_price=?, leader_id=?, bid_count=bid_count+1, end_at=? WHERE id=?').run(amount, uid, ext ? a.end_at + 120000 : a.end_at, aid);
  return { ok: true, ext };
});
app.post('/api/auctions/:id/bids', auth, ready('Blocked accounts cannot bid.'), limit(60, 60000), (req, res) => {
  const amount = Math.floor(+req.body.amount);
  if (!(amount >= 1 && amount <= 1e7)) return fail(res, 400, 'Enter a valid bid.');
  const r = placeBid(req.user.id, +req.params.id, amount);
  if (!r.ok) return fail(res, r.code, r.err);
  broadcast();
  res.json(r);
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
  const t = now(); let changed = false;
  for (const a of db.prepare("SELECT * FROM auctions WHERE status='live' AND end_at<=?").all(t)) {
    changed = true;
    db.prepare("UPDATE auctions SET status='closed' WHERE id=?").run(a.id);
    if (a.bid_count) db.prepare('INSERT INTO orders(auction_id,buyer_id,seller_id,price,ship_fee,ship_by,status,due_at,created) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(a.id, a.leader_id, a.seller_id, a.current_price, a.ship_fee, a.ship_by, 'awaiting_payment', a.end_at + 864e5, t);
  }
  for (const o of db.prepare("SELECT * FROM orders WHERE status='awaiting_payment' AND due_at<=?").all(t)) {
    changed = true;
    db.prepare("UPDATE orders SET status='overdue' WHERE id=?").run(o.id);
    db.prepare('INSERT INTO cases(order_id,reported_id,opened_by,why,created) VALUES(?,?,?,?,?)').run(o.id, o.buyer_id, null, 'Winner did not pay within 24 hours', t);
  }
  return changed;
});
function sweep() { if (sweepTx()) broadcast(); }

// ---------- Admin (only users whose Facebook ID is in ADMIN_FB_IDS) ----------
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

app.use(express.static(path.join(__dirname, 'public')));
app.use('/api', (req, res) => fail(res, 404, 'Not found'));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
function broadcast() { wss.clients.forEach(c => c.readyState === 1 && c.send('refresh')); }

if (require.main === module) {
  setInterval(() => { try { sweep(); } catch (e) { console.error('sweep failed', e); } }, 1000);
  server.listen(+env.PORT || 3000, () => console.log('Holo Bid running on port ' + (env.PORT || 3000) + (DEV ? ' (DEV_AUTH on)' : '')));
}
module.exports = { app, server, db, sweep };
