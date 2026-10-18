// Run: npm test   (starts the server in dev mode on a throwaway database)
process.env.NO_RATE_LIMIT = '1'; process.env.DEV_AUTH = '1'; process.env.DB_FILE = ':memory:'; process.env.ADMIN_FB_IDS = 'dev:owner'; process.env.JWT_SECRET = 'test';
const test = require('node:test'), assert = require('node:assert/strict');
const { server, db, sweep, setPushSender } = require('./server');
let base;
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const call = async (tok, m, p, b) => { const r = await fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: b ? JSON.stringify(b) : undefined }); let j = {}; try { j = await r.json(); } catch {} return { s: r.status, j }; };
async function signup(name, phone) {
  const t = (await call(null, 'POST', '/api/auth/google', { dev: name })).j.token;
  assert.equal((await call(t, 'POST', '/api/auth/details', { phone, city: 'Tel Aviv' })).s, 200);
  assert.equal((await call(t, 'POST', '/api/auth/tos')).s, 200);
  return t;
}
const listing = (o = {}) => ({ city: 'Haifa', type: 'card', title: 'Test Charizard', set: 'Base', cond: 'NM', info: 'x', start: 100, ship: 15, by: 'both', hours: 1, imgs: [PNG, PNG, PNG], ...o });
test.before(() => new Promise(r => server.listen(0, () => { base = 'http://127.0.0.1:' + server.address().port; r(); })));
test.after(() => { server.close(); setTimeout(() => process.exit(0), 100); });

test('full flow', async () => {
  // onboarding gates
  const raw = (await call(null, 'POST', '/api/auth/google', { dev: 'Gate' })).j.token;
  assert.equal((await call(raw, 'POST', '/api/auctions', listing())).s, 403, 'cannot list before verification');
  assert.equal((await call(raw, 'POST', '/api/auth/tos')).s, 403, 'tos needs phone first');
  assert.equal((await call(null, 'GET', '/api/state')).s, 401);
  assert.equal((await call(raw, 'POST', '/api/auth/details', { phone: 'abc', city: 'Haifa' })).s, 400, 'bad phone');
  assert.equal((await call(raw, 'POST', '/api/auth/details', { phone: '050-111-2222', city: ' ' })).s, 400, 'city required');
  assert.equal((await call(raw, 'POST', '/api/auth/phone/start', { phone: '0501112222' })).s, 404, 'sms flow is gone');

  const seller = await signup('Seller S', '0501110001'), a = await signup('Alice A', '0501110002'), b = await signup('Bob B', '0501110003'), owner = await signup('Owner', '0501110004');
  const dup = (await call(null, 'POST', '/api/auth/google', { dev: 'Clone' })).j.token;
  assert.equal((await call(dup, 'POST', '/api/auth/details', { phone: '0501110002', city: 'Haifa' })).s, 409, 'phone unique');

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

test('shipping modes, contact details (phone + city, no Facebook)', async () => {
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
  assert.deepEqual(ship.other, { name: 'C Seller', phone: '+972501117001', city: 'Tel Aviv', av: null }, 'winner sees the seller contact');
  assert.deepEqual(os.find(o => o.title === 'Ship 25').other, { name: 'C Winner', phone: '+972501117002', city: 'Tel Aviv', av: null }, 'seller sees the winner contact');
  assert.deepEqual((await call(x, 'GET', '/api/state')).j.orders, [], 'a stranger sees nothing');
  assert.equal((await call(x, 'POST', '/api/auth/fb-contact', { link: 'dana.levi' })).s, 404, 'the Facebook contact is gone');
  // sign-up gates: details are needed before the Terms
  const nodet = (await call(null, 'POST', '/api/auth/google', { dev: 'No Details' })).j.token;
  assert.equal((await call(nodet, 'POST', '/api/auth/tos')).s, 403, 'tos needs the details first');
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
  assert.equal(sst.user.phone, '+972501115001'); assert.equal(sst.user.fbh, undefined);
  const L = t => sst.myListings.find(x => x.title === t);
  assert.equal(L('Live one').status, 'live'); assert.equal(L('Sold one').status, 'sold'); assert.equal(L('Sold one').price, 100); assert.equal(L('Unsold one').status, 'unsold'); assert.ok(L('Live one').img.startsWith('/api/img/'));
  const bst = (await call(b, 'GET', '/api/state')).j;
  assert.equal(bst.myListings.length, 0); assert.equal(bst.orders.find(x => x.title === 'Sold one').role, 'buyer'); assert.ok(bst.orders[0].aid);
  assert.equal(bst.auctions.find(a => a.id === idLive).lead, true, 'buyer is leading the live one'); assert.equal((await call(o, 'GET', '/api/state')).j.auctions.find(a => a.id === idLive).lead, false);
  // details change: cannot take someone else's number; city is stored and shown to the other party
  assert.equal((await call(b, 'POST', '/api/auth/details', { phone: '0501115001', city: 'Haifa' })).s, 409, 'number of another user');
  assert.equal((await call(b, 'GET', '/api/state')).j.user.phone, '+972501115002', 'unchanged after a refused change');
  assert.equal((await call(b, 'POST', '/api/auth/details', { phone: '0501115099', city: '  Be\'er   Sheva ' })).s, 200);
  assert.equal((await call(b, 'GET', '/api/state')).j.user.city, "Be'er Sheva", 'city trimmed and stored');
  assert.equal((await call(b, 'GET', '/api/state')).j.user.phone, '+972501115099');
  assert.equal((await call(s, 'GET', '/api/state')).j.orders.find(x => x.title === 'Sold one').other.phone, '+972501115099', 'the seller sees the new number');
  assert.equal((await call(s, 'GET', '/api/state')).j.orders.find(x => x.title === 'Sold one').other.city, "Be'er Sheva", 'and the new city');
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
  const again = await call(null, 'POST', '/api/auth/google', { dev: 'P Other' }); assert.equal(again.s, 200); assert.equal(again.j.user.phone_verified, false, 'signing in again starts a fresh account');
});

test('profile picture, pickup note and suggestions', async () => {
  const a = await signup('Pic A', '0501119101'), b = await signup('Pic B', '0501119102'), admin = await signup('Owner', '0501110004');
  const PNG2 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  // avatar
  assert.equal((await call(a, 'POST', '/api/profile/avatar', { img: 'data:text/html;base64,PGI+' })).s, 400, 'only images');
  assert.equal((await call(a, 'POST', '/api/profile/avatar', { img: 'data:image/png;base64,' + Buffer.alloc(300000).toString('base64') })).s, 400, 'too large');
  const up = await call(a, 'POST', '/api/profile/avatar', { img: PNG2 }); assert.equal(up.s, 200); assert.ok(up.j.av.startsWith('/api/avatar/'));
  assert.equal((await call(a, 'GET', '/api/state')).j.user.av, up.j.av, 'own profile has the picture');
  const im = await fetch(base + up.j.av); assert.equal(im.status, 200); assert.equal(im.headers.get('content-type'), 'image/png');
  assert.equal((await fetch(base + '/api/avatar/deadbeef')).status, 404);
  const up2 = await call(a, 'POST', '/api/profile/avatar', { img: PNG2 }); assert.notEqual(up2.j.av, up.j.av, 'replacing changes the address (no stale cache)');
  assert.equal((await fetch(base + up.j.av)).status, 404, 'the old address stops working');
  // the other party of an auction gets the picture, with the pickup note
  const mk = await call(a, 'POST', '/api/auctions', listing({ title: 'Pic card', pickupNote: '  Pokemon   convention, Tel Aviv  ', by: 'pickup', ship: 0 })); assert.equal(mk.s, 200);
  const live = (await call(b, 'GET', '/api/state')).j.auctions.find(x => x.id === mk.j.id); assert.equal(live.pn, 'Pokemon convention, Tel Aviv', 'pickup note trimmed and shown');
  const mk2 = await call(a, 'POST', '/api/auctions', listing({ title: 'No note' })); assert.equal((await call(b, 'GET', '/api/state')).j.auctions.find(x => x.id === mk2.j.id).pn, '');
  assert.equal((await call(a, 'POST', '/api/auctions', listing({ title: 'Long note', pickupNote: 'x'.repeat(500) }))).s, 200);
  assert.equal((await call(b, 'GET', '/api/state')).j.auctions.find(x => x.title === 'Long note').pn.length, 120, 'note capped');
  await call(b, 'POST', `/api/auctions/${mk.j.id}/bids`, { amount: 100, pickup: true });
  db.prepare('UPDATE auctions SET end_at=? WHERE id=?').run(Date.now() - 1, mk.j.id); sweep();
  const ob = (await call(b, 'GET', '/api/state')).j.orders.find(o => o.title === 'Pic card'); assert.ok(ob, 'order created');
  assert.equal(ob.other.av, up2.j.av, 'the winner sees the seller picture'); assert.equal(ob.pn, 'Pokemon convention, Tel Aviv', 'order carries the pickup note');
  assert.equal((await call(a, 'DELETE', '/api/profile/avatar')).s, 200); assert.equal((await call(a, 'GET', '/api/state')).j.user.av, null); assert.equal((await fetch(base + up2.j.av)).status, 404, 'removed');
  // suggestions
  assert.equal((await call(null, 'GET', '/api/suggestions')).s, 401, 'sign in needed');
  assert.equal((await call(a, 'POST', '/api/suggestions', { text: 'hi' })).s, 400, 'too short');
  const s1 = await call(a, 'POST', '/api/suggestions', { text: 'Add a dark mode toggle <b>please</b>' }); assert.equal(s1.s, 200);
  const s2 = await call(b, 'POST', '/api/suggestions', { text: 'Show seller ratings on listings' }); assert.equal(s2.s, 200);
  assert.equal((await call(b, 'POST', `/api/suggestions/${s1.j.id}/vote`, { v: 1 })).s, 200);
  assert.equal((await call(admin, 'POST', `/api/suggestions/${s1.j.id}/vote`, { v: 1 })).s, 200);
  assert.equal((await call(a, 'POST', `/api/suggestions/${s2.j.id}/vote`, { v: -1 })).s, 200);
  assert.equal((await call(b, 'POST', `/api/suggestions/${s1.j.id}/vote`, { v: 5 })).s, 400, 'bad vote value');
  assert.equal((await call(b, 'POST', '/api/suggestions/9999/vote', { v: 1 })).s, 404);
  let list = (await call(b, 'GET', '/api/suggestions')).j;
  assert.equal(list[0].id, s1.j.id, 'highest score first'); assert.equal(list[0].up, 2); assert.equal(list[0].down, 0); assert.equal(list[0].mine, 1); assert.equal(list[0].own, false);
  assert.equal(list[1].down, 1); assert.equal(list[1].own, true); assert.equal(list[1].by, 'P***B', 'author name is masked');
  await call(b, 'POST', `/api/suggestions/${s1.j.id}/vote`, { v: -1 }); list = (await call(b, 'GET', '/api/suggestions')).j;
  const f = list.find(x => x.id === s1.j.id); assert.equal(f.up, 1); assert.equal(f.down, 1); assert.equal(f.mine, -1, 'a vote can be switched, never counted twice');
  await call(b, 'POST', `/api/suggestions/${s1.j.id}/vote`, { v: 0 }); assert.equal((await call(b, 'GET', '/api/suggestions')).j.find(x => x.id === s1.j.id).mine, 0, 'vote removed');
  assert.equal((await call(b, 'DELETE', `/api/suggestions/${s1.j.id}`)).s, 404, 'only the author or admin can delete');
  for (let i = 0; i < 4; i++) await call(a, 'POST', '/api/suggestions', { text: 'More ideas number ' + i });
  assert.equal((await call(a, 'POST', '/api/suggestions', { text: 'One too many today' })).s, 429, 'daily limit');
  assert.equal((await call(a, 'DELETE', `/api/suggestions/${s1.j.id}`)).s, 200, 'author deletes');
  assert.equal((await call(b, 'GET', '/api/suggestions')).j.some(x => x.id === s1.j.id), false);
  assert.equal((await call(a, 'DELETE', `/api/suggestions/${s2.j.id}`)).s, 404);
});

test('share link: /a/<id> serves the app with preview tags for that auction', async () => {
  const s = await signup('Share Seller', '0501118801');
  const mk = await call(s, 'POST', '/api/auctions', listing({ title: 'Pika <script>alert(1)</script> "Rare"', set: 'Base & Co', city: 'Haifa' }));
  assert.equal(mk.s, 200); const id = mk.j.id;
  const r = await fetch(base + '/a/' + id), html = await r.text();
  assert.equal(r.status, 200); assert.ok(html.includes('id="app"'), 'serves the app');
  assert.ok(html.includes('property="og:title"'), 'og:title'); assert.ok(html.includes('/api/img/' + id + '/0'), 'og:image points at the first photo');
  assert.ok(html.includes('property="og:url"') && html.includes('/a/' + id), 'og:url');
  assert.ok(!html.includes('<script>alert(1)</script>'), 'title is escaped'); assert.ok(html.includes('Pika &lt;script&gt;'), 'escaped title shown');
  assert.ok(html.includes('Base &amp; Co'), 'description escaped'); assert.ok(html.includes('Current bid'), 'price in description');
  assert.ok(html.includes('<title>Pika &lt;script'), 'page title is the auction title');
  const none = await fetch(base + '/a/99999'); const nh = await none.text();
  assert.equal(none.status, 200); assert.ok(!nh.includes('og:title'), 'unknown id: plain app, no preview tags');
  assert.notEqual((await fetch(base + '/a/abc')).status, 200, 'non numeric ids are not served as the app');
  assert.ok((await fetch(base + '/a/' + id)).headers.get('cache-control').includes('no-cache'));
  const img = await fetch(base + '/api/img/' + id + '/0'); assert.equal(img.status, 200, 'preview image is public');
});

test('google sign-in checks tokens against our own client id, and admin is by verified email', async () => {
  const realFetch = globalThis.fetch; let aud = 'cid-1', verified = 'true', exp = Math.floor(Date.now() / 1000) + 600, iss = 'https://accounts.google.com';
  globalThis.fetch = async (u, o) => {
    const s = String(u);
    if (!s.startsWith('https://oauth2.googleapis.com/tokeninfo')) return realFetch(u, o);
    const tok = new URL(s).searchParams.get('id_token');
    const json = (j, st = 200) => new Response(JSON.stringify(j), { status: st, headers: { 'Content-Type': 'application/json' } });
    if (tok === 'GOOD') return json({ sub: 'G777', aud, iss, exp: String(exp), email: 'Real.Person@Example.com', email_verified: verified, name: 'Real Person' });
    return json({ error: 'invalid_token' }, 400);
  };
  try {
    const post = b => call(null, 'POST', '/api/auth/google', b);
    delete process.env.GOOGLE_CLIENT_ID;
    assert.equal((await post({ credential: 'GOOD' })).s, 401, 'not configured: refuse every token');
    process.env.GOOGLE_CLIENT_ID = 'cid-1';
    const ok = await post({ credential: 'GOOD' }); assert.equal(ok.s, 200); assert.equal(ok.j.user.name, 'Real Person');
    const row = db.prepare("SELECT fb_id, email FROM users WHERE name='Real Person'").get();
    assert.equal(row.fb_id, 'g:G777'); assert.equal(row.email, 'real.person@example.com');
    assert.equal(ok.j.user.admin, false, 'not admin by default');
    assert.equal((await post({ credential: 'BAD' })).s, 401, 'invalid token');
    assert.equal((await post({})).s, 401, 'no token');
    aud = 'someone-elses-client'; assert.equal((await post({ credential: 'GOOD' })).s, 401, 'token issued to a different client id'); aud = 'cid-1';
    verified = 'false'; assert.equal((await post({ credential: 'GOOD' })).s, 401, 'unverified email'); verified = 'true';
    exp = Math.floor(Date.now() / 1000) - 5; assert.equal((await post({ credential: 'GOOD' })).s, 401, 'expired'); exp = Math.floor(Date.now() / 1000) + 600;
    iss = 'https://evil.example'; assert.equal((await post({ credential: 'GOOD' })).s, 401, 'wrong issuer'); iss = 'https://accounts.google.com';
    // admin by verified email
    process.env.ADMIN_EMAILS = 'real.person@example.com';
    assert.equal((await post({ credential: 'GOOD' })).j.user.admin, true, 'admin by email (case-insensitive)');
    process.env.ADMIN_EMAILS = '';
  } finally { globalThis.fetch = realFetch; delete process.env.GOOGLE_CLIENT_ID; delete process.env.ADMIN_EMAILS; }
});

test('auctions cannot be deleted by anyone; history shows photos', async () => {
  const a = await signup('Del A', '0501119201'), admin = await signup('Owner', '0501110004');
  const mk = await call(a, 'POST', '/api/auctions', listing({ title: 'Undeletable' })); assert.equal(mk.s, 200);
  assert.equal((await call(a, 'POST', '/api/auctions', listing({ title: 'Two photos', imgs: [PNG, PNG] }))).s, 200, 'front and back are enough');
  assert.equal((await call(a, 'POST', '/api/auctions', listing({ title: 'One photo', imgs: [PNG] }))).s, 400, 'one photo is not');
  for (const tok of [a, admin, null]) for (const m of ['DELETE', 'PUT', 'PATCH']) for (const p of [`/api/auctions/${mk.j.id}`, '/api/auctions', `/api/auctions/${mk.j.id}/bids`, `/api/admin/auctions/${mk.j.id}`]) {
    const r = await call(tok, m, p); assert.ok(r.s >= 400, `${m} ${p} refused (${r.s})`);
  }
  assert.throws(() => db.prepare('DELETE FROM auctions WHERE id=?').run(mk.j.id), /cannot be deleted/, 'database refuses deletes');
  assert.throws(() => db.prepare('DELETE FROM bids').run(), /cannot be deleted/);
  assert.throws(() => db.prepare('DELETE FROM images WHERE auction_id=?').run(mk.j.id), /cannot be deleted/);
  assert.ok((await call(a, 'GET', '/api/state')).j.auctions.some(x => x.id === mk.j.id), 'still listed');
  // close it: it moves to history with its photos
  db.prepare('UPDATE auctions SET end_at=? WHERE id=?').run(Date.now() - 1, mk.j.id); sweep();
  const h = (await call(a, 'GET', '/api/state')).j.past.find(x => x.id === mk.j.id);
  assert.ok(h && h.n >= 3, 'history row has id and photo count');
  for (let i = 0; i < h.n; i++) assert.equal((await fetch(`${base}/api/img/${h.id}/${i}`)).status, 200, 'photo ' + i + ' served');
});
