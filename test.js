// Run: npm test   (starts the server in dev mode on a throwaway database)
process.env.DEV_AUTH = '1'; process.env.DB_FILE = ':memory:'; process.env.ADMIN_FB_IDS = 'dev:owner'; process.env.JWT_SECRET = 'test';
const test = require('node:test'), assert = require('node:assert/strict');
const { server, db, sweep } = require('./server');
let base;
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const call = async (tok, m, p, b) => { const r = await fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: b ? JSON.stringify(b) : undefined }); let j = {}; try { j = await r.json(); } catch {} return { s: r.status, j }; };
async function signup(name, phone) {
  const t = (await call(null, 'POST', '/api/auth/facebook', { dev: name })).j.token;
  const s = await call(t, 'POST', '/api/auth/phone/start', { phone });
  assert.equal(s.s, 200); assert.ok(s.j.devCode);
  assert.equal((await call(t, 'POST', '/api/auth/phone/verify', { code: s.j.devCode })).s, 200);
  assert.equal((await call(t, 'POST', '/api/auth/tos')).s, 200);
  return t;
}
const listing = (o = {}) => ({ type: 'card', title: 'Test Charizard', set: 'Base', cond: 'NM', info: 'x', start: 100, ship: 15, by: 'buyer', hours: 1, ref: 0, imgs: [PNG, PNG, PNG], ...o });
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
  const id2 = (await call(seller, 'POST', '/api/auctions', listing({ title: 'Pack Z', type: 'booster', by: 'seller', hours: 0.5 }))).j.id;

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
