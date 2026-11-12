// 클라우드 시험용 설정: ADMIN_PASSWORD(화면 Basic 인증), SHOP_TOKEN(시험 매장 시드)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { loadOrCreateShops } from '../src/shops.js';
import { SHOPS, http as call } from './harness.mjs';

const PASSWORD = 'correct-horse-battery';
const basic = (pw, user = 'anyone') => ({ authorization: `Basic ${Buffer.from(`${user}:${pw}`).toString('base64')}` });

/** adminPort 없이 띄운다(= ADMIN_PASSWORD 모드에서 main.js 가 하는 방식) */
async function startWith(config) {
  const app = createApp({ shops: SHOPS.map((s) => ({ ...s })), config });
  const port = await app.listen(0, '127.0.0.1');
  return { app, base: `http://127.0.0.1:${port}`, close: () => app.close() };
}

test('ADMIN_PASSWORD 가 없으면 화면·/api 는 별도 포트에만 있고 POS 포트에서는 404', async () => {
  const app = createApp({ shops: SHOPS.map((s) => ({ ...s })), config: {} });
  const port = await app.listen(0, '127.0.0.1', { adminPort: 0 });
  try {
    const pos = `http://127.0.0.1:${port}`;
    assert.equal((await call(pos, 'GET', '/')).status, 404);
    assert.equal((await call(pos, 'GET', '/api/state')).status, 404);
    assert.equal((await call(pos, 'GET', '/api/state', { headers: basic(PASSWORD) })).status, 404);
    assert.equal((await call(`http://127.0.0.1:${app.adminPort}`, 'GET', '/')).status, 200);
  } finally { await app.close(); }
});

test('ADMIN_PASSWORD 가 있으면 POS 포트에서 Basic 인증을 거친다: 없음 401, 틀림 401, 맞음 200', async () => {
  const t = await startWith({ adminPassword: PASSWORD });
  try {
    for (const path of ['/', '/api/state']) {
      const none = await call(t.base, 'GET', path);
      assert.equal(none.status, 401, `${path} 인증 없음`);
      assert.equal(none.headers.get('www-authenticate'), 'Basic realm="admin"');
      assert.equal(none.headers.get('cache-control'), 'no-store');
      const wrong = await call(t.base, 'GET', path, { headers: basic('wrong-password-123') });
      assert.equal(wrong.status, 401, `${path} 틀린 비밀번호`);
      assert.equal(wrong.headers.get('www-authenticate'), 'Basic realm="admin"');
      const ok = await call(t.base, 'GET', path, { headers: basic(PASSWORD, 'someone-else') }); // 사용자 이름은 아무거나
      assert.equal(ok.status, 200, `${path} 맞는 비밀번호`);
      assert.equal(ok.headers.get('cache-control'), 'no-store');
    }
    // Basic 이 아닌 형식, 콜론 없는 값, 비밀번호가 접두사만 같은 경우도 거절
    assert.equal((await call(t.base, 'GET', '/api/state', { headers: { authorization: `Bearer ${PASSWORD}` } })).status, 401);
    assert.equal((await call(t.base, 'GET', '/api/state', { headers: { authorization: `Basic ${Buffer.from(PASSWORD).toString('base64')}` } })).status, 401);
    assert.equal((await call(t.base, 'GET', '/api/state', { headers: basic(`${PASSWORD}x`) })).status, 401);
    // 프록시 헤더가 붙어도(Render 뒤) 인증만 맞으면 열린다
    assert.equal((await call(t.base, 'GET', '/api/state', { headers: { ...basic(PASSWORD), 'x-forwarded-for': '203.0.113.9' } })).status, 200);
    // 쓰기 API 도 인증 필요, 인증 후에는 JSON 만 받는다
    assert.equal((await call(t.base, 'POST', '/api/work-orders', { body: { shopId: 1, label: 'x', lines: [] } })).status, 401);
    const created = await call(t.base, 'POST', '/api/work-orders', {
      headers: basic(PASSWORD),
      body: { shopId: 1, label: '시험 작업', lines: [{ title: '엔진오일', unitPrice: 50000, quantity: 1 }] },
    });
    assert.equal(created.status, 201);
    // 기존 경로는 그대로: /health 는 인증 없이, /pos/* 는 매장 토큰으로
    assert.equal((await call(t.base, 'GET', '/health')).status, 200);
    assert.equal((await call(t.base, 'GET', '/pos/poll?clientId=x&wait=0')).status, 401);
    assert.equal((await call(t.base, 'GET', '/pos/poll?clientId=x&wait=0', { token: SHOPS[0].token })).status, 200);
  } finally { await t.close(); }
});

test('ADMIN_PASSWORD 인증이 같은 IP 에서 10분에 10번 틀리면 429(맞는 비밀번호도 그동안 거절), IP 별로 센다', async () => {
  const t = await startWith({ adminPassword: PASSWORD });
  try {
    const from = (ip, pw) => ({ headers: { ...basic(pw), 'x-forwarded-for': `${ip}, 10.0.0.1` } });
    for (let i = 0; i < 10; i += 1) {
      assert.equal((await call(t.base, 'GET', '/api/state', from('198.51.100.7', 'nope-nope-nope'))).status, 401, `${i + 1}번째`);
    }
    const blocked = await call(t.base, 'GET', '/api/state', from('198.51.100.7', 'nope-nope-nope'));
    assert.equal(blocked.status, 429);
    assert.equal(blocked.headers.get('www-authenticate'), null);
    assert.equal((await call(t.base, 'GET', '/api/state', from('198.51.100.7', PASSWORD))).status, 429);
    // 다른 IP 는 영향 없음
    assert.equal((await call(t.base, 'GET', '/api/state', from('198.51.100.8', PASSWORD))).status, 200);
    // /pos/* 는 이 제한과 무관
    assert.equal((await call(t.base, 'GET', '/pos/poll?clientId=x&wait=0', { token: SHOPS[0].token, headers: { 'x-forwarded-for': '198.51.100.7' } })).status, 200);
  } finally { await t.close(); }
});

test('10분이 지나면 인증 실패 기록이 풀린다', async () => {
  let now = Date.now();
  const app = createApp({ shops: SHOPS.map((s) => ({ ...s })), config: { adminPassword: PASSWORD }, clock: { now: () => now } });
  const port = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; i < 10; i += 1) await call(base, 'GET', '/api/state', { headers: basic('nope-nope-nope') });
    assert.equal((await call(base, 'GET', '/api/state', { headers: basic(PASSWORD) })).status, 429);
    now += 10 * 60_000 + 1;
    assert.equal((await call(base, 'GET', '/api/state', { headers: basic(PASSWORD) })).status, 200);
  } finally { await app.close(); }
});

test('ADMIN_PASSWORD 가 12자 미만이면 설정을 읽을 때·서버를 만들 때 오류', () => {
  assert.throws(() => loadConfig({ ADMIN_PASSWORD: 'a'.repeat(11) }), /12자/);
  assert.equal(loadConfig({ ADMIN_PASSWORD: 'a'.repeat(12) }).adminPassword, 'a'.repeat(12));
  assert.equal(loadConfig({}).adminPassword, '');
  assert.throws(() => createApp({ config: { adminPassword: 'short' } }), /12자/);
});

test('SHOP_TOKEN: 파일이 없으면 그 토큰으로 시험 매장을 만들고, /pos/poll 인증에 쓸 수 있다', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shop-seed-'));
  const token = 'seeded-token-0123456789abcdef';
  try {
    const config = loadConfig({ SHOP_TOKEN: token, SHOP_NAME: '클라우드 시험 매장' });
    let created = null;
    const shops = loadOrCreateShops(dir, (s) => { created = s; }, { token: config.shopToken, name: config.shopName });
    assert.deepEqual(shops, [{ id: 1, name: '클라우드 시험 매장', token }]);
    assert.equal(created.token, token);
    // 파일이 이미 있으면 SHOP_TOKEN 이 바뀌어도 기존 파일을 따른다
    assert.equal(loadOrCreateShops(dir, () => assert.fail('다시 만들면 안 돼요'), { token: 'another-token-0123456789abcdef' })[0].token, token);

    const app = createApp({ shops, config });
    const port = await app.listen(0, '127.0.0.1');
    const base = `http://127.0.0.1:${port}`;
    try {
      assert.equal((await call(base, 'GET', '/pos/poll?clientId=x&wait=0', { token })).status, 200);
      assert.equal((await call(base, 'GET', '/pos/poll?clientId=x&wait=0', { token: 'wrong-token-0123456789abcdef' })).status, 401);
    } finally { await app.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('SHOP_TOKEN 이 없으면 무작위 토큰, 24자 미만이면 거절(파일도 만들지 않는다)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shop-seed-'));
  try {
    assert.throws(() => loadConfig({ SHOP_TOKEN: 't'.repeat(23) }), /24자/);
    assert.equal(loadConfig({ SHOP_TOKEN: 't'.repeat(24) }).shopToken.length, 24);
    assert.throws(() => loadOrCreateShops(dir, () => {}, { token: 't'.repeat(23) }), /24자/);
    assert.equal(existsSync(join(dir, 'shops.json')), false);
    const [shop] = loadOrCreateShops(dir, () => {}, {});
    assert.equal(shop.name, '시험 매장');
    assert.ok(shop.token.length >= 24);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
