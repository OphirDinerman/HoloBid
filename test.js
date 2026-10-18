// Run: npm test   (starts the server in dev mode on a throwaway database)
process.env.NO_RATE_LIMIT = '1'; process.env.DEV_AUTH = '1'; process.env.DB_FILE = ':memory:'; process.env.ADMIN_FB_IDS = 'dev:owner'; process.env.JWT_SECRET = 'test';
const test = require('node:test'), assert = require('node:assert/strict');
const { server, db, sweep, setPushSender } = require('./server');
let base;
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const call = async (tok, m, p, b) => { const r = await fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: b ? JSON.stringify(b) : undefined }); let j = {}; try { j = await r.json(); } catch {} return { s: r.status, j }; };
async function signup(name, phone) {
  const t = (await call(null, 'POST', '/api/auth/facebook', { dev: name })).j.token;
  const s = await call(t, 'POST', '/api/auth/phone/start', { phone });
  assert.equal(s.s, 200); assert.ok(s.j.devCode);
  assert.equal((await call(t, 'POST', '/api/auth/phone/verify', { code: s.j.devCode })).s, 200);
  assert.equal((await call(t, 'POST', '/api/auth/fb-contact', { link: 'https://www.facebook.com/user.' + phone.replace(/\D/g, '') })).s, 200);
  assert.equal((await call(t, 'POST', '/api/auth/tos')).s, 200);
  return t;
}
const listing = (o = {}) => ({ city: 'Haifa', type: 'card', title: 'Test Charizard', set: 'Base', cond: 'NM', info: 'x', start: 100, ship: 15, by: 'both', hours: 1, imgs: [PNG, PNG, PNG], ...o });
test.before(() => new Promise(r => server.listen(0, () => { base = 'http://127.0.0.1:' + server.address().port; r(); })));
test.after(() => { server.close(); setTimeout(() => process.exit(0), 100); });

test('full flow', async () => {
  // onboarding gates
  const raw = (await call(null, 'POST', '/api/auth/facebook', { dev: 'Gate' })).j.token;
  assert.equal((await call(raw, 'POST', '/api/auctions', listing())).s, 403, 'cannot list before verification');
  assert.equal((await call(raw, 'POST', '/api/auth/tos')).s, 403, 'tos needs phone first');
  assert.equal((await call(null, 'GET', '/api/state')).s, 401);
  const w = await call(raw, 'POST', '/api/auth/phone/start', { phone: '050-111-2222' });
  assert.equal((await call(raw, 'POST', '/api/auth/phone/verify', { code: '000000' })).s, 400, 'wrong otp');
  assert.equal((await call(raw, 'POST', '/api/auth/phone/start', { phone: '0501112222' })).s, 429, 'otp throttled');

  const seller = await signup('Seller S', '0501110001'), a = await signup('Alice A', '0501110002'), b = await signup('Bob B', '0501110003'), owner = await signup('Owner', '0501110004');
  const dup = (await call(null, 'POST', '/api/auth/facebook', { dev: 'Clone' })).j.token;
  assert.equal((await call(dup, 'POST', '/api/auth/phone/start', { phone: '0501110002' })).s, 409, 'phone unique');

  // listing validation
  assert.equal((await call(seller, 'POST', '/api/auctions', listing({ imgs: [PNG] }))).s, 400);
  assert.equal((await call(seller, 'POST', '/api/auctions', listing({ imgs: ['http://x/a.png', PNG, PNG] }))).s, 400);
  const id = (await call(seller, 'POST', '/api/auctions', listing())).j.id; assert.ok(id);
  const id2 = (await call(seller, 'POST', '/api/auctions', listing({ title: 'Pack Z', type: 'booster', by: 'both', ship: 0, hours: 0.5 }))).j.id;

  // state + masked names + images
  let st = (await call(a, 'GET', '/api/state')).j;
  assert.equal(st.auctions.length, 2); assert.equal(st.auctions[0].mine, false);
  assert.equal((await call(seller, 'GET', '/api/state')).j.auctions[0].mine, true);
  assert.equal((await fetch(base + st.auctions[0].imgs[0])).status, 200);

  // bidding rules
  assert.equal((await call(seller, 'POST', `/api/auctions/${id}/bids`, { amount: 500 })).s, 403, 'no self bid');
  assert.equal((await call(a, 'POST', `/api/auctions/${id}/bids`, { amount: 50 })).s, 409, 'below start');
  assert.equal((await call(a, 'POST', `/api/auctions/${id}/bids`, { amount: 100 })).s, 200);
  assert.equal((await call(b, 'POST', `/api/auctions/${id}/bids`, { amount: 105 })).s, 409, 'below increment');
  // race: two simultaneous equal bids -> exactly one wins
  const rs = await Promise.all([call(a, 'POST', `/api/auctions/${id}/bids`, { amount: 150 }), call(b, 'POST', `/api/auctions/${id}/bids`, { amount: 150 })]);
  assert.deepEqual(rs.map(r => r.s).sort(), [200, 409], 'race resolved');
  st = (await call(a, 'GET', '/api/state')).j; const au = st.auctions.find(x => x.id === id);
  assert.equal(au.bids.length, 2); assert.ok(au.bids.every(x => /^.\*\*\*.$/.test(x.u)), 'masked');
  // anti-sniping
  db.prepare('UPDATE auctions SET end_at=? WHERE id=?').run(Date.now() + 60000, id2);
  const before = db.prepare('SELECT end_at FROM auctions WHERE id=?').get(id2).end_at;
  assert.equal((await call(b, 'POST', `/api/auctions/${id2}/bids`, { amount: 100 })).j.ext, true);
  assert.equal(db.prepare('SELECT end_at FROM auctions WHERE id=?').get(id2).end_at - before, 120000);

  // close -> order with 24h window
  db.prepare('UPDATE auctions SET end_at=? WHERE id IN (?,?)').run(Date.now() - 1, id, id2); sweep();
  assert.equal((await call(a, 'POST', `/api/auctions/${id}/bids`, { amount: 999 })).s, 409, 'closed');
  st = (await call(a, 'GET', '/api/state')).j; const win = st.orders.find(o => o.title === 'Test Charizard') || st.orders[0];
  const o1 = (await call(a, 'GET', '/api/state')).j.orders.concat((await call(b, 'GET', '/api/state')).j.orders).find(o => o.title === 'Test Charizard');
  assert.ok(o1 && o1.status === 'awaiting_payment'); assert.ok(Math.abs(o1.due - (Date.now() + 864e5)) < 5000);
  assert.ok((await call(a, 'GET', '/api/state')).j.past.some(p => p.title === 'Test Charizard' && p.price === 150), 'in public history');
  const buyerTok = (await call(a, 'GET', '/api/state')).j.orders.some(o => o.title === 'Test Charizard') ? a : b;
  const oid = o1.id;

  // order flow + role checks
  assert.equal((await call(seller, 'POST', `/api/orders/${oid}/paid`)).s, 403, 'seller cannot claim paid');
  assert.equal((await call(buyerTok, 'POST', `/api/orders/${oid}/paid`)).s, 200);
  assert.equal((await call(buyerTok, 'POST', `/api/orders/${oid}/paid`)).s, 409, 'state check');
  assert.equal((await call(seller, 'POST', `/api/orders/${oid}/recv`)).s, 200);
  assert.equal((await call(seller, 'POST', `/api/orders/${oid}/ship`)).s, 200);
  assert.equal((await call(buyerTok, 'POST', `/api/orders/${oid}/got`)).s, 200);

  // non-payment: overdue creates a case; admin hidden from others
  const o2 = (await call(b, 'GET', '/api/state')).j.orders.find(o => o.title === 'Pack Z');
  db.prepare('UPDATE orders SET due_at=? WHERE id=?').run(Date.now() - 1, o2.id); sweep();
  assert.equal((await call(a, 'GET', '/api/state')).j.cases, undefined, 'non-admin gets no cases');
  assert.equal((await call(seller, 'POST', '/api/admin/cases/1', { action: 'block', note: 'x' })).s, 404, 'admin route hidden');
  const ost = (await call(owner, 'GET', '/api/state')).j; assert.equal(ost.user.admin, true); assert.equal(ost.cases.length, 1);
  const cid = ost.cases[0].id;
  assert.equal((await call(owner, 'POST', `/api/admin/cases/${cid}`, { action: 'block', note: '' })).s, 400, 'note required');
  assert.equal((await call(owner, 'POST', `/api/admin/cases/${cid}`, { action: 'block', note: 'no payment after 24h' })).s, 200);
  assert.equal((await call(b, 'POST', `/api/auctions/${id}/bids`, { amount: 1 })).s, 403, 'blocked cannot bid');
  assert.equal((await call(b, 'POST', '/api/auctions', listing())).s, 403, 'blocked cannot list');
  assert.equal((await call(owner, 'POST', `/api/admin/cases/${cid}`, { action: 'dismiss', note: 'again' })).s, 409, 'already resolved');
  assert.deepEqual((await call(owner, 'GET', '/api/state')).j.blocked, ['Bob B']);
});

test('pickup and city', async () => {
  const s = await signup('Pick S', '0501119001'), b1 = await signup('Pick B', '0501119002'), b2 = await signup('Pick C', '0501119003');
  assert.equal((await call(s, 'POST', '/api/auctions', listing({ city: '' }))).s, 400, 'city required');
  assert.equal((await call(s, 'POST', '/api/auctions', listing({ city: 'x' }))).s, 400, 'city too short');
  const idA = (await call(s, 'POST', '/api/auctions', listing({ title: 'Pickup item', city: 'Kiryat Ono', by: 'both' }))).j.id;
  const idB = (await call(s, 'POST', '/api/auctions', listing({ title: 'Pickup only item', city: 'Haifa', by: 'pickup', ship: '' }))).j.id;
  const st = (await call(b1, 'GET', '/api/state')).j; assert.equal(st.auctions.find(a => a.id === idA).city, 'Kiryat Ono');
  assert.equal((await call(b1, 'POST', `/api/auctions/${idA}/bids`, { amount: 100, pickup: true })).s, 200);
  assert.equal((await call(b2, 'POST', `/api/auctions/${idB}/bids`, { amount: 100, pickup: true })).s, 200);
  db.prepare('UPDATE auctions SET end_at=? WHERE id IN (?,?)').run(Date.now() - 1, idA, idB); sweep();
  const ob = (await call(b1, 'GET', '/api/state')).j.orders.find(o => o.title === 'Pickup item');
  assert.equal(ob.pickup, true); assert.equal(ob.city, 'Kiryat Ono'); assert.equal(ob.by, 'both');
  const oc = (await call(b2, 'GET', '/api/state')).j.orders.find(o => o.title === 'Pickup only item');
  assert.equal(oc.pickup, true, 'pickup-only items are always picked up, even if the bid says shipping');
  // a later bid without pickup switches the choice back
  const idC = (await call(s, 'POST', '/api/auctions', listing({ title: 'Switch item' }))).j.id;
  await call(b1, 'POST', `/api/auctions/${idC}/bids`, { amount: 100, pickup: true });
  await call(b2, 'POST', `/api/auctions/${idC}/bids`, { amount: 110 });
  db.prepare('UPDATE auctions SET end_at=? WHERE id=?').run(Date.now() - 1, idC); sweep();
  assert.equal((await call(b2, 'GET', '/api/state')).j.orders.find(o => o.title === 'Switch item').pickup, false);
});

test('notifications', async () => {
  const sent = []; setPushSender(async (sub, payload) => { sent.push({ sub, payload }); });
  const wait = () => new Promise(r => setTimeout(r, 60));
  const s = await signup('N Seller', '0501118001'), a = await signup('N Alice', '0501118002'), b = await signup('N Bob', '0501118003');
  const id = (await call(s, 'POST', '/api/auctions', listing({ title: 'Notif item' }))).j.id;
  const notifs = async t => (await call(t, 'GET', '/api/state')).j.notifs;
  assert.equal((await call(a, 'POST', '/api/push/subscribe', { endpoint: 'http://insecure', keys: { p256dh: 'k', auth: 'a' } })).s, 400, 'https endpoint only');
  assert.equal((await call(a, 'POST', '/api/push/subscribe', { endpoint: 'https://push.example/abc', keys: { p256dh: 'k', auth: 'a' } })).s, 200);
  await call(a, 'POST', `/api/auctions/${id}/bids`, { amount: 100 });
  await call(a, 'POST', `/api/auctions/${id}/bids`, { amount: 110 });
  assert.equal((await notifs(a)).length, 0, 'no notification for your own bids');
  await call(b, 'POST', `/api/auctions/${id}/bids`, { amount: 120 });
  let n = await notifs(a); assert.equal(n.length, 1); assert.equal(n[0].type, 'outbid'); assert.equal(n[0].amount, 120); assert.equal(n[0].read, false);
  assert.equal((await notifs(b)).length, 0, 'the outbidder gets nothing');
  await wait(); assert.equal(sent.length, 1); assert.match(sent[0].payload.body, /outbid on "Notif item"/);
  // Hebrew push text follows the language saved in the user profile
  await call(a, 'POST', '/api/prefs', { lang: 'he' });
  await call(a, 'POST', `/api/auctions/${id}/bids`, { amount: 130 }); await call(b, 'POST', `/api/auctions/${id}/bids`, { amount: 140 }); await wait();
  assert.match(sent[1].payload.body, /הצעה גבוהה/);
  // switched off -> nothing saved, nothing pushed
  await call(a, 'POST', '/api/prefs', { outbid: false, won: true, lang: 'he' });
  await call(a, 'POST', `/api/auctions/${id}/bids`, { amount: 150 }); await call(b, 'POST', `/api/auctions/${id}/bids`, { amount: 160 }); await wait();
  assert.equal((await notifs(a)).length, 2); assert.equal(sent.length, 2);
  assert.deepEqual((await call(a, 'GET', '/api/state')).j.prefs, { outbid: false, won: true, sold: true, lang: 'he' });
  await call(a, 'POST', '/api/notifications/read'); assert.ok((await notifs(a)).every(x => x.read));
  // winner gets a "won" notification when the auction closes
  await call(b, 'POST', '/api/push/subscribe', { endpoint: 'https://push.example/bob', keys: { p256dh: 'k', auth: 'a' } });
  db.prepare('UPDATE auctions SET end_at=? WHERE id=?').run(Date.now() - 1, id); sweep(); await wait();
  n = await notifs(b); assert.equal(n[0].type, 'won'); assert.equal(n[0].amount, 160); assert.equal(n.filter(x => x.type === 'outbid').length, 2, 'Bob was outbid twice earlier');
  assert.equal((await notifs(a)).length, 2, 'the loser is not told they won');
  assert.ok(sent.some(x => x.sub.endpoint.endsWith('/bob') && /You won/.test(x.payload.body)));
  // dead subscriptions are removed
  setPushSender(async () => { const e = new Error('gone'); e.statusCode = 410; throw e; });
  const id2 = (await call(s, 'POST', '/api/auctions', listing({ title: 'Gone item' }))).j.id;
  await call(a, 'POST', `/api/auctions/${id2}/bids`, { amount: 100 }); await call(b, 'POST', `/api/auctions/${id2}/bids`, { amount: 110 }); await wait();
  assert.equal(db.prepare("SELECT COUNT(*) c FROM push_subs WHERE endpoint='https://push.example/abc'").get().c, 1, 'alice has outbid notifications off, so no push attempt');
  await call(a, 'POST', '/api/prefs', { outbid: true }); await call(a, 'POST', `/api/auctions/${id2}/bids`, { amount: 120 }); await call(b, 'POST', `/api/auctions/${id2}/bids`, { amount: 130 }); await wait();
  assert.equal(db.prepare("SELECT COUNT(*) c FROM push_subs WHERE endpoint='https://push.example/abc'").get().c, 0, '410 removes the subscription');
  assert.equal((await call(a, 'POST', '/api/push/unsubscribe', { endpoint: 'https://push.example/abc' })).s, 200);
});

test('shipping modes, contact details and facebook link parsing', async () => {
  const s = await signup('C Seller', '0501117001'), w = await signup('C Winner', '0501117002'), x = await signup('C Stranger', '0501117003');
  assert.equal((await call(s, 'POST', '/api/auctions', listing({ by: 'buyer' }))).s, 400, 'old buyer-pays mode is gone');
  assert.equal((await call(s, 'POST', '/api/auctions', listing({ by: 'both', ship: '' }))).s, 400, 'pickup-or-shipping needs a price');
  const idP = (await call(s, 'POST', '/api/auctions', listing({ title: 'PU only', by: 'pickup', ship: 99 }))).j.id;
  const idB = (await call(s, 'POST', '/api/auctions', listing({ title: 'Ship 25', by: 'both', ship: 25 }))).j.id;
  const st = (await call(w, 'GET', '/api/state')).j;
  const A = id => st.auctions.find(a => a.id === id);
  assert.equal(A(idP).by, 'pickup'); assert.equal(A(idP).ship, 0, 'pickup-only ignores any shipping price'); assert.equal(A(idB).by, 'both'); assert.equal(A(idB).ship, 25);
  assert.deepEqual((await call(w, 'GET', '/api/state')).j.orders, [], 'no contact details before an auction is won');
  await call(w, 'POST', `/api/auctions/${idB}/bids`, { amount: 100, pickup: false }); await call(w, 'POST', `/api/auctions/${idP}/bids`, { amount: 100 });
  db.prepare('UPDATE auctions SET end_at=? WHERE id IN (?,?)').run(Date.now() - 1, idP, idB); sweep();
  const ow = (await call(w, 'GET', '/api/state')).j.orders, os = (await call(s, 'GET', '/api/state')).j.orders;
  const ship = ow.find(o => o.title === 'Ship 25'), pu = ow.find(o => o.title === 'PU only');
  assert.equal(ship.pickup, false); assert.equal(ship.ship, 25); assert.equal(pu.pickup, true);
  assert.deepEqual(ship.other, { name: 'C Seller', phone: '+972501117001', fb: 'user.0501117001' }, 'winner sees the seller contact');
  assert.deepEqual(os.find(o => o.title === 'Ship 25').other, { name: 'C Winner', phone: '+972501117002', fb: 'user.0501117002' }, 'seller sees the winner contact');
  assert.deepEqual((await call(x, 'GET', '/api/state')).j.orders, [], 'a stranger sees nothing');
  // Facebook link parsing
  const ok = async (link, expect) => { const r = await call(x, 'POST', '/api/auth/fb-contact', { link }); assert.equal(r.s, 200, link); assert.equal(r.j.fb, expect, link); };
  await ok('https://www.facebook.com/dana.levi', 'dana.levi'); await ok('facebook.com/dana.levi/', 'dana.levi'); await ok('m.facebook.com/dana.levi?ref=x', 'dana.levi');
  await ok('https://www.facebook.com/profile.php?id=100012345678901', '100012345678901'); await ok('@dana.levi', 'dana.levi'); await ok('https://m.me/dana.levi', 'dana.levi'); await ok('dana.levi', 'dana.levi');
  for (const bad of ['', 'abc', 'https://example.com/dana.levi', 'https://www.facebook.com/groups/123456', 'a b c d e f', '<script>alert(1)</script>']) assert.equal((await call(x, 'POST', '/api/auth/fb-contact', { link: bad })).s, 400, 'rejects ' + bad);
  // sign-up gates: no Facebook contact or old ToS version -> cannot bid
  const nofb = (await call(null, 'POST', '/api/auth/facebook', { dev: 'No Fb' })).j.token; const c = await call(nofb, 'POST', '/api/auth/phone/start', { phone: '0501117009' });
  await call(nofb, 'POST', '/api/auth/phone/verify', { code: c.j.devCode });
  assert.equal((await call(nofb, 'POST', '/api/auth/tos')).s, 403, 'tos needs the facebook contact first');
  db.prepare("UPDATE users SET tos_version='1.0' WHERE id=(SELECT id FROM users WHERE name='C Stranger')").run();
  assert.equal((await call(x, 'POST', `/api/auctions/${idB}/bids`, { amount: 1 })).s, 403, 'old ToS version must be re-accepted');
});

test('seller is told when the item sells', async () => {
  const sent = []; setPushSender(async (sub, payload) => { sent.push({ sub, payload }); });
  const wait = () => new Promise(r => setTimeout(r, 60));
  const s = await signup('Sold Seller', '0501116001'), b = await signup('Sold Buyer', '0501116002');
  await call(s, 'POST', '/api/push/subscribe', { endpoint: 'https://push.example/seller', keys: { p256dh: 'k', auth: 'a' } });
  const id1 = (await call(s, 'POST', '/api/auctions', listing({ title: 'Sells' }))).j.id, id2 = (await call(s, 'POST', '/api/auctions', listing({ title: 'No bids' }))).j.id;
  await call(b, 'POST', `/api/auctions/${id1}/bids`, { amount: 120 });
  db.prepare('UPDATE auctions SET end_at=? WHERE id IN (?,?)').run(Date.now() - 1, id1, id2); sweep(); await wait();
  const n = (await call(s, 'GET', '/api/state')).j.notifs; assert.equal(n.length, 1, 'only the item that sold'); assert.equal(n[0].type, 'sold'); assert.equal(n[0].amount, 120); assert.equal(n[0].title, 'Sells');
  assert.match(sent.find(x => x.sub.endpoint.endsWith('/seller')).payload.body, /"Sells" sold for ₪120/);
  assert.ok((await call(s, 'GET', '/api/state')).j.prefs.sold === true);
  await call(s, 'POST', '/api/prefs', { sold: false, lang: 'he' });
  const id3 = (await call(s, 'POST', '/api/auctions', listing({ title: 'Sells quietly' }))).j.id; await call(b, 'POST', `/api/auctions/${id3}/bids`, { amount: 100 });
  db.prepare('UPDATE auctions SET end_at=? WHERE id=?').run(Date.now() - 1, id3); sweep(); await wait();
  assert.equal((await call(s, 'GET', '/api/state')).j.notifs.length, 1, 'switched off: nothing saved'); assert.equal(sent.length, 1);
  await call(s, 'POST', '/api/prefs', { sold: true });
  const id4 = (await call(s, 'POST', '/api/auctions', listing({ title: 'Hebrew item' }))).j.id; await call(b, 'POST', `/api/auctions/${id4}/bids`, { amount: 100 });
  db.prepare('UPDATE auctions SET end_at=? WHERE id=?').run(Date.now() - 1, id4); sweep(); await wait();
  assert.match(sent[1].payload.body, /נמכר ב-₪100/);
  assert.equal((await call(b, 'GET', '/api/state')).j.notifs.filter(x => x.type === 'sold').length, 0, 'the buyer is not told the item sold');
});

test('profile data, phone change, account deletion and legal pages', async () => {
  const s = await signup('P Seller', '0501115001'), b = await signup('P Buyer', '0501115002'), o = await signup('P Other', '0501115003');
  const idLive = (await call(s, 'POST', '/api/auctions', listing({ title: 'Live one' }))).j.id, idSold = (await call(s, 'POST', '/api/auctions', listing({ title: 'Sold one' }))).j.id, idNone = (await call(s, 'POST', '/api/auctions', listing({ title: 'Unsold one' }))).j.id;
  await call(b, 'POST', `/api/auctions/${idSold}/bids`, { amount: 100 }); await call(b, 'POST', `/api/auctions/${idLive}/bids`, { amount: 100 });
  db.prepare('UPDATE auctions SET end_at=? WHERE id IN (?,?)').run(Date.now() - 1, idSold, idNone); sweep();
  const sst = (await call(s, 'GET', '/api/state')).j;
  assert.equal(sst.user.phone, '+972501115001'); assert.ok(sst.user.fbh);
  const L = t => sst.myListings.find(x => x.title === t);
  assert.equal(L('Live one').status, 'live'); assert.equal(L('Sold one').status, 'sold'); assert.equal(L('Sold one').price, 100); assert.equal(L('Unsold one').status, 'unsold'); assert.ok(L('Live one').img.startsWith('/api/img/'));
  const bst = (await call(b, 'GET', '/api/state')).j;
  assert.equal(bst.myListings.length, 0); assert.equal(bst.orders.find(x => x.title === 'Sold one').role, 'buyer'); assert.ok(bst.orders[0].aid);
  assert.equal(bst.auctions.find(a => a.id === idLive).lead, true, 'buyer is leading the live one'); assert.equal((await call(o, 'GET', '/api/state')).j.auctions.find(a => a.id === idLive).lead, false);
  // phone change: needs a code, and cannot take someone else's number
  assert.equal((await call(b, 'POST', '/api/auth/phone/start', { phone: '0501115001' })).s, 409, 'number of another user');
  const ps = await call(b, 'POST', '/api/auth/phone/start', { phone: '0501115099' }); assert.equal(ps.s, 200);
  assert.equal((await call(b, 'POST', '/api/auth/phone/verify', { code: '000000' })).s, 400);
  assert.equal((await call(b, 'GET', '/api/state')).j.user.phone, '+972501115002', 'unchanged until verified');
  assert.equal((await call(b, 'POST', '/api/auth/phone/verify', { code: ps.j.devCode })).s, 200);
  assert.equal((await call(b, 'GET', '/api/state')).j.user.phone, '+972501115099');
  assert.equal((await call(s, 'GET', '/api/state')).j.orders.find(x => x.title === 'Sold one').other.phone, '+972501115099', 'the seller sees the new number');
  // security headers + legal pages
  const r = await fetch(base + '/privacy'); assert.equal(r.status, 200); assert.equal(r.headers.get('x-frame-options'), 'DENY'); const t = await r.text(); assert.ok(t.includes('Privacy policy') && t.includes('contact@example.com') && !t.includes('{{'));
  for (const pg of ['terms', 'data-deletion']) assert.equal((await fetch(base + '/' + pg)).status, 200);
  // deletion rules: blocked by live auctions and open orders, allowed for an uninvolved user
  assert.equal((await call(s, 'POST', '/api/account/delete')).s, 409, 'seller has a live auction');
  assert.equal((await call(b, 'POST', '/api/account/delete')).s, 409, 'buyer leads a live auction');
  db.prepare('UPDATE auctions SET end_at=? WHERE id=?').run(Date.now() - 1, idLive); sweep();
  assert.equal((await call(b, 'POST', '/api/account/delete')).s, 409, 'open orders block deletion');
  db.prepare("UPDATE orders SET status='completed'").run();
  assert.equal((await call(b, 'POST', '/api/account/delete')).s, 200);
  assert.equal((await call(b, 'GET', '/api/state')).s, 401, 'old token stops working');
  const row = db.prepare("SELECT * FROM users WHERE name='Deleted user'").get();
  assert.ok(row && row.phone === null && row.fb_handle === null && row.fb_id.startsWith('deleted:'), 'personal data erased');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM bids WHERE bidder_id=?').get(row.id).c >= 1, true, 'bid records stay');
  assert.equal((await call(s, 'GET', '/api/state')).j.orders.find(x => x.title === 'Sold one').other.phone, null, 'the seller no longer sees a deleted number');
  assert.equal((await call(o, 'POST', '/api/account/delete')).s, 200, 'uninvolved user can delete');
  const again = await call(null, 'POST', '/api/auth/facebook', { dev: 'P Other' }); assert.equal(again.s, 200); assert.equal(again.j.user.phone_verified, false, 'signing in again starts a fresh account');
});

test('facebook login checks tokens against our own app', async () => {
  const realFetch = globalThis.fetch; let appIdOfToken = '111';
  globalThis.fetch = async (u, o) => {
    const s = String(u);
    if (!s.startsWith('https://graph.facebook.com/')) return realFetch(u, o);
    const url = new URL(s), tok = url.searchParams.get('access_token') || url.searchParams.get('input_token');
    const json = j => new Response(JSON.stringify(j), { headers: { 'Content-Type': 'application/json' } });
    if (url.pathname === '/me') return tok === 'GOOD' ? json({ id: 'FB777', name: 'Real Person' }) : json({ error: { message: 'bad' } });
    if (url.pathname === '/debug_token') return json({ data: { is_valid: true, app_id: appIdOfToken } });
    return json({});
  };
  try {
    const post = b => call(null, 'POST', '/api/auth/facebook', b);
    delete process.env.FB_APP_ID; delete process.env.FB_APP_SECRET;
    assert.equal((await post({ accessToken: 'GOOD' })).s, 401, 'not configured: refuse every token');
    process.env.FB_APP_ID = '111'; process.env.FB_APP_SECRET = 'secret';
    const ok = await post({ accessToken: 'GOOD' }); assert.equal(ok.s, 200); assert.equal(ok.j.user.name, 'Real Person');
    assert.equal(db.prepare("SELECT fb_id FROM users WHERE name='Real Person'").get().fb_id, 'FB777');
    assert.equal((await post({ accessToken: 'BAD' })).s, 401, 'invalid token');
    appIdOfToken = '222'; assert.equal((await post({ accessToken: 'GOOD' })).s, 401, 'token issued to a different app');
    assert.equal((await post({})).s, 401, 'no token');
  } finally { globalThis.fetch = realFetch; delete process.env.FB_APP_ID; delete process.env.FB_APP_SECRET; }
});
