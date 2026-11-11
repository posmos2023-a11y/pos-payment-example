import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { PosClient, SHOPS, http as call, startApp } from './harness.mjs';
import { createApp } from '../src/server.js';

let t;
before(async () => { t = await startApp(); });
after(() => t.close());

test('토큰이 없거나 틀리면 /pos/* 는 401 {"error":"UNAUTHORIZED"}', async () => {
  for (const path of ['/pos/poll?clientId=x&wait=0', '/pos/events']) {
    const method = path.startsWith('/pos/events') ? 'POST' : 'GET';
    const body = method === 'POST' ? { clientId: 'x', messages: [] } : undefined;
    for (const token of [undefined, 'wrong-token']) {
      const r = await call(t.base, method, path, { token, body });
      assert.equal(r.status, 401, `${method} ${path}`);
      assert.deepEqual(r.json, { error: 'UNAUTHORIZED' });
      assert.equal(r.headers.get('access-control-allow-origin'), '*'); // 오류 응답에도 CORS
    }
  }
});

test('맞는 토큰이면 통과하고 OPTIONS 는 204 + CORS 헤더', async () => {
  const ok = await call(t.base, 'GET', '/pos/poll?clientId=x&wait=0', { token: SHOPS[0].token });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json, { commands: [] });
  const opt = await call(t.base, 'OPTIONS', '/pos/events');
  assert.equal(opt.status, 204);
  assert.equal(opt.headers.get('access-control-allow-headers'), 'Authorization, Content-Type');
  assert.equal(opt.headers.get('access-control-allow-methods'), 'GET, POST, OPTIONS');
});

test('WebSocket 업그레이드는 토큰이 없거나 틀리면 업그레이드 전에 401 로 거절', async () => {
  await assert.rejects(new PosClient(t.port, '').connect(), { status: 401 });
  await assert.rejects(new PosClient(t.port, 'wrong').connect(), { status: 401 });
});

test('다른 경로로의 업그레이드는 404 로 거절', async () => {
  const status = await new Promise((resolve) => {
    const req = http.request({
      port: t.port, host: '127.0.0.1', path: '/pos/other',
      headers: {
        Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', Authorization: `Bearer ${SHOPS[0].token}`,
      },
    });
    req.on('response', (res) => resolve(res.statusCode));
    req.on('upgrade', () => resolve(101));
    req.end();
  });
  assert.equal(status, 404);
});

test('토큰은 매장별로 다르다: 매장 B 토큰으로 온 단말은 매장 B 에만 등록된다', async () => {
  await call(t.base, 'GET', '/pos/poll?clientId=shopB-dev&wait=0', { token: SHOPS[1].token });
  const state = (await call(t.base, 'GET', '/api/state')).json;
  assert.ok(state.shops.find((s) => s.id === 2).clients.some((c) => c.clientId === 'shopB-dev'));
  assert.ok(!state.shops.find((s) => s.id === 1).clients.some((c) => c.clientId === 'shopB-dev'));
});

test('화면·내부 API 는 프록시 헤더가 있으면 403, JSON 이 아닌 쓰기는 415', async () => {
  assert.equal((await call(t.base, 'GET', '/api/state')).status, 200);
  assert.equal((await call(t.base, 'GET', '/')).status, 200);
  assert.equal((await call(t.base, 'GET', '/api/state', { headers: { 'x-forwarded-for': '1.2.3.4' } })).status, 403);
  const r = await call(t.base, 'POST', '/api/work-orders', { body: 'a=b', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  assert.equal(r.status, 415);
});

/** 업그레이드 요청을 날것으로 보내고 응답 상태(소켓이 그냥 끊기면 0)를 돌려준다. */
function rawUpgrade(port, path) {
  return new Promise((resolve) => {
    const req = http.request({
      port, host: '127.0.0.1', path,
      headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==' },
    });
    req.on('response', (res) => resolve(res.statusCode));
    req.on('upgrade', () => resolve(101));
    req.on('error', () => resolve(0));
    req.end();
  });
}

test('인증 전의 이상한 업그레이드 요청(경로 "//")으로 서버가 죽지 않는다', async () => {
  assert.notEqual(await rawUpgrade(t.port, '//'), 101);
  // 그 뒤에도 서버가 살아서 정상 요청에 답한다
  const ok = await call(t.base, 'GET', '/pos/poll?clientId=x&wait=0', { token: SHOPS[0].token });
  assert.equal(ok.status, 200);
});

test('adminPort 를 주면 화면·내부 API 는 그 포트에서만 열리고 POS 포트에서는 404', async () => {
  const app = createApp({ shops: SHOPS.map((s) => ({ ...s })) });
  const port = await app.listen(0, '127.0.0.1', { adminPort: 0 });
  try {
    const pos = `http://127.0.0.1:${port}`;
    const admin = `http://127.0.0.1:${app.adminPort}`;
    assert.notEqual(app.adminPort, port);
    // POS 포트(프록시가 밖으로 넘기는 포트)에는 화면이 없다
    assert.equal((await call(pos, 'GET', '/api/state')).status, 404);
    assert.equal((await call(pos, 'GET', '/')).status, 404);
    assert.equal((await call(pos, 'GET', '/pos/poll?clientId=x&wait=0', { token: SHOPS[0].token })).status, 200);
    // 화면 포트에는 화면만 있다
    assert.equal((await call(admin, 'GET', '/api/state')).status, 200);
    assert.equal((await call(admin, 'GET', '/')).status, 200);
    assert.equal((await call(admin, 'GET', '/pos/poll?clientId=x&wait=0', { token: SHOPS[0].token })).status, 404);
  } finally { await app.close(); }
});
