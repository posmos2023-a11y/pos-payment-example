import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PosClient, SHOPS, api, events, http, makeWorkOrder, sleep, startApp, until } from './harness.mjs';

const T1 = SHOPS[0].token;
const view = async (base, id) => (await api(base, 'GET', '/api/state')).json.shops[0].workOrders.find((w) => w.id === id);
const paid = (wo, extra = {}) => ({ type: 'payment.paid', paymentId: 'p1', orderId: 'o1', workOrderIds: [wo.id], fullyPaid: true, paidValue: 81000, unpaidValue: 0, ...extra });

test('hello 전에는 아무것도 보내지 않고, hello 마다 welcome', async () => {
  const t = await startApp();
  try {
    const c = await new PosClient(t.port, T1).connect();
    c.send({ type: 'pong', t: 1 });
    await sleep(200);
    assert.equal(c.messages.length, 0);
    await c.join();
    c.hello();
    await until(() => c.messages.filter((m) => m.type === 'welcome').length === 2);
    c.close();
  } finally { await t.close(); }
});

test('[담기] -> command 수신 -> ack -> DONE', async () => {
  const t = await startApp();
  try {
    const c = await new PosClient(t.port, T1).connect();
    await c.join();
    const wo = await makeWorkOrder(t.base);
    assert.equal((await api(t.base, 'POST', `/api/work-orders/${wo.id}/cart`, {})).status, 200);
    const cmd = (await c.waitFor((m) => m.type === 'command')).command;
    assert.equal(cmd.kind, 'SYNC_CART');
    assert.equal(cmd.payload.workOrderId, wo.id);
    assert.equal(cmd.payload.startPayment, true);
    assert.equal(cmd.payload.lines[0].key, `gm-${wo.id}-1`);
    c.send({ type: 'ack', commandId: cmd.id, ok: true, draft: null });
    await until(async () => (await view(t.base, wo.id)).posState === 'APPLIED');
    assert.equal(t.app.store.commands.get(cmd.id).status, 'DONE');
    c.close();
  } finally { await t.close(); }
});

test('HTTP 경로: /pos/events hello -> welcome, /pos/poll 로 명령 수신', async () => {
  const t = await startApp();
  try {
    const r = await events(t.base, T1, 'http-1', [{ type: 'hello', clientId: 'http-1', processedIds: [] }]);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.replies[0].type, 'welcome');
    const wo = await makeWorkOrder(t.base);
    await api(t.base, 'POST', `/api/work-orders/${wo.id}/cart`, {});
    const p = await http(t.base, 'GET', '/pos/poll?clientId=http-1&wait=1', { token: T1 });
    assert.equal(p.json.commands.length, 1);
    assert.equal(p.json.commands[0].kind, 'SYNC_CART');
  } finally { await t.close(); }
});

test('결제 금액 일치 = 결제완료, 같은 paymentId 중복은 무시, 결제완료 후 [담기] 거부', async () => {
  const t = await startApp();
  try {
    const wo = await makeWorkOrder(t.base);
    await events(t.base, T1, 'c', [paid(wo)]);
    assert.equal((await view(t.base, wo.id)).status, 'PAID');
    await events(t.base, T1, 'c', [paid(wo, { paidValue: 1 })]); // 중복
    assert.equal((await view(t.base, wo.id)).paidAmount, 81000);
    assert.equal((await api(t.base, 'POST', `/api/work-orders/${wo.id}/cart`, {})).status, 409);
  } finally { await t.close(); }
});

test('단말이 작업 번호·금액 없이 먼저 보고한 결제도, 토스로 확인된 같은 결제가 오면 반영된다', async () => {
  const t = await startApp();
  try {
    const wo = await makeWorkOrder(t.base);
    // 플러그인이 작업을 못 찾고 주문 조회도 실패한 경우의 보고
    await events(t.base, T1, 'c', [paid(wo, { workOrderIds: [], fullyPaid: false, paidValue: 0, unpaidValue: -1 })]);
    assert.equal((await view(t.base, wo.id)).status, 'PENDING_PAYMENT');
    const confirmed = { paymentId: 'p1', orderId: 'o1', workOrderIds: [wo.id], fullyPaid: true, paidValue: 81000, unpaidValue: 0, source: 'toss-webhook' };
    assert.equal(t.app.payments.paid(SHOPS[0].id, confirmed), 'done');
    assert.equal((await view(t.base, wo.id)).status, 'PAID');
    assert.equal(t.app.payments.paid(SHOPS[0].id, confirmed), 'duplicate'); // 같은 등급의 되풀이는 버린다
  } finally { await t.close(); }
});

test('취소가 먼저 처리된 결제는 승인이 뒤늦게 와도 결제완료로 만들지 않는다', async () => {
  const t = await startApp();
  try {
    const wo = await makeWorkOrder(t.base);
    assert.equal(t.app.payments.cancelled(SHOPS[0].id, { paymentId: 'p1', orderId: 'o1', source: 'toss-webhook' }), 'recorded');
    const late = { paymentId: 'p1', orderId: 'o1', workOrderIds: [wo.id], fullyPaid: true, paidValue: 81000, unpaidValue: 0, source: 'toss-webhook' };
    assert.equal(t.app.payments.paid(SHOPS[0].id, late), 'ignored');
    assert.equal((await view(t.base, wo.id)).status, 'PENDING_PAYMENT');
  } finally { await t.close(); }
});

test('금액 불일치 = 확인 필요', async () => {
  const t = await startApp();
  try {
    const wo = await makeWorkOrder(t.base);
    await events(t.base, T1, 'c', [paid(wo, { paidValue: 70000 })]);
    const v = await view(t.base, wo.id);
    assert.equal(v.status, 'REVIEW');
    assert.match(v.reviewReason, /금액 확인 필요/);
  } finally { await t.close(); }
});

test('결제 취소 = 취소(환불), 환불된 작업은 다시 [담기] 가능', async () => {
  const t = await startApp();
  try {
    const wo = await makeWorkOrder(t.base);
    await events(t.base, T1, 'c', [paid(wo)]);
    await events(t.base, T1, 'c', [{ type: 'payment.cancelled', paymentId: 'other', orderId: 'o1' }]); // orderId 로 찾기
    assert.equal((await view(t.base, wo.id)).status, 'REFUNDED');
    assert.equal((await api(t.base, 'POST', `/api/work-orders/${wo.id}/cart`, {})).status, 200);
    assert.equal((await view(t.base, wo.id)).status, 'PENDING_PAYMENT');
  } finally { await t.close(); }
});
