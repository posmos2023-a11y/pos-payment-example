import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SHOPS, events, http, makeWorkOrder, startApp } from './harness.mjs';
import { signWebhook } from '../src/toss.js';

const SECRET = 'test-secret';
const body = (o = {}) => JSON.stringify({
  id: 'e1', type: 'payment.payment.approved.v1', merchantId: 'M1',
  data: { payment: { id: 'pay1', orderId: 'ord1', amount: 81000, merchantId: 'M1' } }, ...o,
});
function post(t, raw, { sign = true, ts = String(Date.now()), id = 'wh1', tamper = false } = {}) {
  let sig = signWebhook(SECRET, ts, Buffer.from(raw));
  if (tamper) sig = sig.slice(0, -1) + (sig.endsWith('0') ? '1' : '0');
  const headers = sign ? { 'x-toss-webhook-id': id, 'x-toss-timestamp': ts, 'x-toss-signature': sig } : {};
  return http(t.base, 'POST', '/toss/webhook', { body: raw, headers });
}

test('웹훅 서명: 정상 200, 한 글자 변조 401, 오래된 시각 400, 헤더 없음 400, 중복 id 는 200 duplicate', async () => {
  const t = await startApp({ config: { tossWebhookSecret: SECRET } });
  try {
    assert.equal((await post(t, body())).status, 200);
    assert.equal((await post(t, body(), { id: 'wh2', tamper: true })).status, 401);
    assert.equal((await post(t, body(), { id: 'wh3', ts: String(Date.now() - 10 * 60_000) })).status, 400);
    assert.equal((await post(t, body(), { sign: false })).status, 400);
    const dup = await post(t, body());
    assert.equal(dup.status, 200);
    assert.equal(dup.json.duplicate, true);
  } finally { await t.close(); }
});

test('시크릿 미설정이면 503', async () => {
  const t = await startApp();
  try { assert.equal((await post(t, body())).status, 503); } finally { await t.close(); }
});

test('승인 웹훅: 가짜 Open API 로 주문 조회 -> 결제완료, 취소 웹훅 -> 취소(환불)', async () => {
  const { createServer } = await import('node:http');
  let order = null;
  let seen = null;
  const fake = createServer((req, res) => {
    seen = { url: req.url, key: req.headers['x-access-key'], secret: req.headers['x-secret-key'] };
    res.end(JSON.stringify({ resultType: 'SUCCESS', success: order }));
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  const t = await startApp({
    config: { tossWebhookSecret: SECRET, tossAccessKey: 'ak', tossSecretKey: 'sk', tossBaseUrl: `http://127.0.0.1:${fake.address().port}/v1` },
  });
  try {
    const wo = await makeWorkOrder(t.base);
    t.app.store.setMerchantId(SHOPS[0].id, 'M1');
    order = {
      lineItems: [{ memo: `#${wo.id} 12가3456` }], chargePrice: { totalAmount: 81000 },
      payments: [{ id: 'pay1', amount: 81000 }],
    };
    await post(t, body());
    await t.app.webhook.idle();
    assert.equal(seen.url, '/v1/merchants/M1/order/orders/ord1');
    assert.deepEqual([seen.key, seen.secret], ['ak', 'sk']);
    const state = async () => (await http(t.base, 'GET', '/api/state')).json.shops[0].workOrders[0].status;
    assert.equal(await state(), 'PAID');

    order = { ...order, payments: [{ id: 'pay1', amount: 81000, state: 'CANCELLED' }] };
    await post(t, body({ type: 'payment.payment.cancelled.v1' }), { id: 'wh9' });
    await t.app.webhook.idle();
    assert.equal(await state(), 'REFUNDED');
  } finally { await t.close(); fake.close(); }
});

test('Open API 키가 있으면 단말의 payment.paid 는 주문을 조회해 확인한 값으로만 반영한다', async () => {
  const { createServer } = await import('node:http');
  let order = null;
  const fake = createServer((req, res) => { res.end(JSON.stringify({ resultType: 'SUCCESS', success: order })); });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  const t = await startApp({
    config: { tossAccessKey: 'ak', tossSecretKey: 'sk', tossBaseUrl: `http://127.0.0.1:${fake.address().port}/v1` },
  });
  try {
    const wo = await makeWorkOrder(t.base);
    t.app.store.setMerchantId(SHOPS[0].id, 'M1');
    const status = async () => (await http(t.base, 'GET', '/api/state')).json.shops[0].workOrders[0].status;
    const memo = [{ memo: `#${wo.id} 12가3456` }];

    // 단말은 "전액 결제"라고 주장하지만 토스의 주문에는 30000원만 결제돼 있다 -> 결제완료가 되지 않는다
    order = { lineItems: memo, chargePrice: { totalAmount: 81000 }, payments: [{ id: 'p1', amount: 30000 }] };
    await events(t.base, SHOPS[0].token, 'c', [
      { type: 'payment.paid', paymentId: 'p1', orderId: 'o1', workOrderIds: [wo.id], fullyPaid: true, paidValue: 81000, unpaidValue: 0 },
    ]);
    await t.app.webhook.idle();
    assert.equal(await status(), 'PENDING_PAYMENT');

    // 단말이 작업 번호도 금액도 못 보냈어도, 주문이 전액 결제됐고 메모에 작업 번호가 있으면 결제완료
    order = { lineItems: memo, chargePrice: { totalAmount: 81000 }, payments: [{ id: 'p1', amount: 30000 }, { id: 'p2', amount: 51000 }] };
    await events(t.base, SHOPS[0].token, 'c', [
      { type: 'payment.paid', paymentId: 'p2', orderId: 'o1', workOrderIds: [], fullyPaid: false, paidValue: 0, unpaidValue: -1 },
    ]);
    await t.app.webhook.idle();
    assert.equal(await status(), 'PAID');
  } finally { await t.close(); fake.close(); }
});