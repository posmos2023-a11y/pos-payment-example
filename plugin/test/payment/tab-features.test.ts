// 4단계 신규 기능 테스트: merchantId, 결제 대기 기록(paywatch), 놓친 결제 찾기(reconcile), 탭 수명·설정.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MERCHANT_ID_KEY, PAYMENTS_KEY, PROCESSED_KEY } from '../../src/payment/bridge.ts';
import {
  PAYWATCH_KEY,
  PAYWATCH_MAX,
  PAYWATCH_MAX_AGE_MS,
  PaywatchStore,
  parsePaywatch,
  removePaywatchFor,
  upsertPaywatch,
} from '../../src/payment/paywatch.ts';
import type { PaywatchEntry } from '../../src/payment/paywatch.ts';
import { RECONCILE_LOOKBACK_MS, RECONCILE_RETRY_MS, workOrderIdsOf } from '../../src/payment/reconcile.ts';
import { createPaymentRuntime } from '../../src/payment/runtime.ts';
import type { OrderDetailLike } from '../../src/payment/sdk-types.ts';
import { FakeClock, settle } from './fake-clock.ts';
import { FakeRateLimitError, FakeSdk } from './fake-sdk.ts';
import { FakeTransport, createHarness, line, syncCmd } from './harness.ts';
import type { Harness } from './harness.ts';

const WELCOME = { type: 'welcome', serverVersion: '1.0.0', serverTime: '2026-11-03T09:00:00' } as const;

function order(
  id: string,
  state: OrderDetailLike['paymentState'],
  memos: (string | undefined)[],
  payments: string[],
  paid = 60000,
  unpaid = 0,
): OrderDetailLike {
  return {
    id,
    paymentState: state,
    lineItems: memos.map((m) => (m === undefined ? {} : { memo: m })),
    payments: payments.map((p) => ({ id: p, state: 'APPROVED' })),
    paymentPrice: { paymentUnpaidValue: unpaid, paymentPaidValue: paid },
  };
}

function watchEntries(h: { sdk: FakeSdk }): PaywatchEntry[] {
  const raw = h.sdk.store.get(PAYWATCH_KEY);
  return raw ? (JSON.parse(raw) as PaywatchEntry[]) : [];
}

// ---------------------------------------------------------------------------

describe('hello 의 merchantId', () => {
  it('getMerchant 로 한 번 가져와 gm.merchantId 에 캐시하고 hello 에 문자열로 싣는다', async () => {
    const h = await createHarness();
    assert.equal(h.sdk.store.get(MERCHANT_ID_KEY), '4242');
    assert.equal(h.ctxs[0]!.getHello('ws').merchantId, '4242');
    assert.equal(h.sdk.callsOf('merchant.getMerchant').length, 1);
  });

  it('캐시가 있으면 getMerchant 를 부르지 않는다', async () => {
    const sdk = new FakeSdk();
    sdk.store.set(MERCHANT_ID_KEY, '777');
    const h = await createHarness({ sdk });
    assert.equal(sdk.callsOf('merchant.getMerchant').length, 0);
    assert.equal(h.ctxs[0]!.getHello('ws').merchantId, '777');
  });

  it('getMerchant 가 실패하면(호출 제한 등) 무시하고 진행하며 hello 에서 필드를 뺀다', async () => {
    const sdk = new FakeSdk();
    sdk.merchant_ = new FakeRateLimitError();
    const h = await createHarness({ sdk });
    const hello = h.ctxs[0]!.getHello('ws');
    assert.equal('merchantId' in hello, false);
    assert.equal(sdk.store.has(MERCHANT_ID_KEY), false);
    assert.equal(h.bridge.getStatus().online, true, '연결은 정상 진행');
  });
});

// ---------------------------------------------------------------------------

describe('paywatch 순수 로직', () => {
  const now = Date.UTC(2026, 10, 3, 9, 0, 0);
  const entry = (ids: number[], atMs: number): PaywatchEntry => ({
    workOrderIds: ids,
    keys: ids.map((i) => `gm-${i}-1`),
    total: 1000,
    at: new Date(atMs).toISOString(),
  });

  it('같은 workOrderIds(순서·중복 무관)면 갱신하고, 다르면 추가한다', () => {
    let list = upsertPaywatch([], entry([1, 2], now - 60_000), now);
    list = upsertPaywatch(list, entry([2, 1], now), now);
    assert.equal(list.length, 1);
    assert.equal(list[0]!.at, new Date(now).toISOString());
    list = upsertPaywatch(list, entry([3], now), now);
    assert.equal(list.length, 2);
  });

  it('최대 20개(가장 최근 것)만 남긴다', () => {
    let list: PaywatchEntry[] = [];
    for (let i = 1; i <= 25; i++) list = upsertPaywatch(list, entry([i], now), now);
    assert.equal(list.length, PAYWATCH_MAX);
    assert.deepEqual(list[0]!.workOrderIds, [6]);
    assert.deepEqual(list[19]!.workOrderIds, [25]);
  });

  it('3시간이 지나면 버린다(불러올 때·추가할 때 모두)', () => {
    const old = entry([1], now - PAYWATCH_MAX_AGE_MS - 1);
    const edge = entry([2], now - PAYWATCH_MAX_AGE_MS);
    assert.deepEqual(
      parsePaywatch(JSON.stringify([old, edge]), now).map((e) => e.workOrderIds),
      [[2]],
    );
    assert.deepEqual(
      upsertPaywatch([old, edge], entry([3], now), now).map((e) => e.workOrderIds),
      [[2], [3]],
    );
  });

  it('잘못된 JSON/항목은 무시한다', () => {
    assert.deepEqual(parsePaywatch('not json', now), []);
    assert.deepEqual(parsePaywatch(JSON.stringify([{ workOrderIds: [], keys: [], total: 1, at: 'x' }, 5, null]), now), []);
  });

  it('겹치는 작업 ID 의 기록을 지운다', () => {
    const list = [entry([1, 2], now), entry([3], now)];
    assert.deepEqual(
      removePaywatchFor(list, [2]).map((e) => e.workOrderIds),
      [[3]],
    );
  });

  it('PaywatchStore: 저장/복원/삭제', async () => {
    const sdk = new FakeSdk();
    const clock = new FakeClock();
    const store = new PaywatchStore(sdk.storage, clock);
    await store.add({ workOrderIds: [7], keys: ['gm-7-1'], total: 5000 });
    assert.equal(watchEntries({ sdk }).length, 1);
    const store2 = new PaywatchStore(sdk.storage, clock);
    await store2.load();
    assert.deepEqual(store2.entries()[0]!.workOrderIds, [7]);
    await store2.removeFor([7]);
    assert.deepEqual(watchEntries({ sdk }), []);
  });
});

// ---------------------------------------------------------------------------

describe('paywatch 저장 시점 / 삭제 (bridge)', () => {
  it('SYNC_CART(lines>0)를 적용하면 startPayment 보다 먼저 gm.paywatch 에 저장한다', async () => {
    const h = await createHarness();
    await h.run(syncCmd(12, [line(12, 1, { unitPrice: 50000 }), line(12, 2, { unitPrice: 10000, quantity: 2 })], { startPayment: true }));
    const names = h.sdk.calls.map((c) => (c.name === 'storage.set' ? `set:${String(c.args[0])}` : c.name));
    const iSave = names.lastIndexOf(`set:${PAYWATCH_KEY}`);
    const iPay = names.indexOf('draftOrder.startPayment');
    assert.ok(iSave >= 0, 'paywatch 저장됨');
    assert.ok(iPay >= 0, 'startPayment 호출됨');
    assert.ok(iSave < iPay, 'startPayment 전에 저장');
    const e = watchEntries(h);
    assert.equal(e.length, 1);
    assert.deepEqual(e[0]!.workOrderIds, [12]);
    assert.deepEqual(e[0]!.keys, ['gm-12-1', 'gm-12-2']);
    assert.equal(e[0]!.total, 70000);
    assert.match(e[0]!.at, /^\d{4}-\d{2}-\d{2}T/);
  });

  it('처리 이력(gm.processed)도 startPayment 보다 먼저 저장한다(탭이 다시 로드돼도 같은 명령을 또 실행하지 않게)', async () => {
    const h = await createHarness();
    await h.run(syncCmd(12, [line(12, 1)], { startPayment: true }));
    const names = h.sdk.calls.map((c) => (c.name === 'storage.set' ? `set:${String(c.args[0])}` : c.name));
    const iSave = names.indexOf(`set:${PROCESSED_KEY}`);
    const iPay = names.indexOf('draftOrder.startPayment');
    assert.ok(iSave >= 0, '처리 이력 저장됨');
    assert.ok(iPay >= 0, 'startPayment 호출됨');
    assert.ok(iSave < iPay, 'startPayment 전에 저장');
  });

  it('결제 화면을 열지 않는 SYNC(startPayment:false)도 기록하고, 같은 작업이면 갱신한다', async () => {
    const h = await createHarness();
    await h.run(syncCmd(12, [line(12, 1)]));
    await h.run(syncCmd(12, [line(12, 1), line(12, 2)]));
    assert.equal(watchEntries(h).length, 1);
    assert.deepEqual(watchEntries(h)[0]!.keys, ['gm-12-1', 'gm-12-2']);
  });

  it('lines 가 비면(빼기) 기록하지 않는다', async () => {
    const h = await createHarness();
    await h.run(syncCmd(12, [], { exclusive: false }));
    assert.deepEqual(watchEntries(h), []);
  });

  it('[결제 화면 열기](openPayment)도 startPayment 전에 저장한다', async () => {
    const h = await createHarness();
    await h.run(syncCmd(12, [line(12, 1)]));
    h.sdk.store.delete(PAYWATCH_KEY);
    h.sdk.resetCalls();
    await h.bridge.openPayment();
    const names = h.sdk.calls.map((c) => (c.name === 'storage.set' ? `set:${String(c.args[0])}` : c.name));
    assert.ok(names.indexOf(`set:${PAYWATCH_KEY}`) < names.indexOf('draftOrder.startPayment'));
    assert.equal(watchEntries(h)[0]!.workOrderIds[0], 12);
  });

  it('openPayment 는 수동 라인만 있으면 기록 없이 결제 화면만 연다', async () => {
    const h = await createHarness();
    h.sdk.addManualLine('manual-1', '수동 상품');
    h.sdk.emitDraftUpdate();
    await h.bridge.openPayment();
    assert.deepEqual(watchEntries(h), []);
    assert.equal(h.sdk.callsOf('draftOrder.startPayment').length, 1);
  });

  it('그 작업의 전액 결제(fullyPaid)를 보내면 기록을 지우고, 부분 결제는 남긴다', async () => {
    const h = await createHarness();
    await h.run(syncCmd(12, [line(12, 1)]));
    h.sdk.setOrder('ord-1', 5000, 5000);
    h.sdk.emitPaid('pay-1', 'ord-1');
    await settle();
    assert.equal(watchEntries(h).length, 1, '부분 결제: 유지');
    h.sdk.setOrder('ord-1', 0, 10000);
    h.sdk.emitPaid('pay-2', 'ord-1');
    await settle();
    assert.deepEqual(watchEntries(h), [], '전액 결제: 삭제');
  });

  it('다시 시작해도(탭 재로드) 저장된 기록을 복원한다', async () => {
    const h = await createHarness();
    await h.run(syncCmd(12, [line(12, 1)]));
    await h.bridge.stop();
    const h2 = await createHarness({ sdk: h.sdk, clock: h.clock, wire: false });
    h2.sdk.ordersList = [];
    h2.transport.serverSend(WELCOME);
    await settle();
    assert.equal(h2.sdk.callsOf('order.getOrders').length, 1, '복원된 기록이 있어 조회한다');
  });
});

// ---------------------------------------------------------------------------

describe('놓친 결제 찾기(reconcile)', () => {
  async function withWatch(): Promise<Harness> {
    const h = await createHarness();
    await h.run(syncCmd(12, [line(12, 1, { unitPrice: 60000 })]));
    h.sdk.resetCalls();
    h.transport.sent.length = 0;
    return h;
  }

  it('workOrderIdsOf: 항목 메모의 #작업ID 를 모은다(우리 형식이 아닌 항목은 무시)', () => {
    const o = order('o', 'PAID', ['#12 홍길동', '#12 홍길동', '#7', undefined, '직원 메모', 'gm-5-1'], ['p']);
    assert.deepEqual(workOrderIdsOf(o), [7, 12]);
  });

  it('welcome 을 처음 받은 뒤 1회만 getOrders 를 부른다(start~now 범위, size 50)', async () => {
    const h = await withWatch();
    h.sdk.ordersList = [];
    h.transport.serverSend(WELCOME);
    await settle();
    h.transport.serverSend(WELCOME);
    await settle();
    const calls = h.sdk.callsOf('order.getOrders');
    assert.equal(calls.length, 1, '두 번째 welcome 에서는 부르지 않는다');
    const p = calls[0]!.args[0] as { start: string; end: string; size: number };
    assert.equal(p.size, 50);
    assert.equal(p.end, new Date(h.clock.now()).toISOString());
    const at = Date.parse(watchEntries(h)[0]!.at);
    assert.equal(Date.parse(p.start), at - RECONCILE_LOOKBACK_MS, '가장 오래된 at − 2분');
  });

  it('paywatch 가 비어 있으면 getOrders 를 부르지 않는다', async () => {
    const h = await createHarness();
    h.transport.serverSend(WELCOME);
    await settle();
    assert.equal(h.sdk.callsOf('order.getOrders').length, 0);
    const r = await h.bridge.reconcile();
    assert.equal(r.ran, false);
    assert.equal(h.sdk.callsOf('order.getOrders').length, 0);
  });

  it('PAID 주문: 메모에서 작업 ID 를 읽어 payment.paid 를 보내고, 완납이면 기록을 지운다', async () => {
    const h = await withWatch();
    h.sdk.ordersList = [
      order('ord-9', 'PAID', ['#12 12가1234 홍길동'], ['pay-9']),
      order('ord-x', 'PAID', ['직원 메모'], ['pay-x']), // 우리 주문이 아님
      order('ord-open', 'OPENED', ['#12 12가1234'], []),
    ];
    const r = await h.bridge.reconcile();
    assert.deepEqual([r.ran, r.paid, r.cancelled], [true, 1, 0]);
    assert.deepEqual(h.transport.of('payment.paid'), [
      {
        type: 'payment.paid',
        paymentId: 'pay-9',
        orderId: 'ord-9',
        workOrderIds: [12],
        fullyPaid: true,
        paidValue: 60000,
        unpaidValue: 0,
      },
    ]);
    assert.deepEqual(watchEntries(h), []);
    // bridge 의 sendPayment 를 거쳤으므로 gm.payments 에 보존된다
    assert.match(h.sdk.store.get(PAYMENTS_KEY)!, /pay-9/);
  });

  it('paymentPrice 가 없거나 payments 가 배열이 아닌 주문이 섞여 있어도 나머지 주문은 처리한다', async () => {
    const h = await withWatch();
    const noPrice = order('ord-np', 'PAID', ['#12'], ['pay-np']) as unknown as Record<string, unknown>;
    delete noPrice.paymentPrice;
    const badPrice = order('ord-bp', 'PAID', ['#12'], ['pay-bp']) as unknown as Record<string, unknown>;
    badPrice.paymentPrice = { paymentPaidValue: 'x', paymentUnpaidValue: null };
    const noPayments = order('ord-nl', 'PAID', ['#12'], ['pay-nl']) as unknown as Record<string, unknown>;
    noPayments.payments = undefined;
    const cancelledNoList = order('ord-cn', 'CANCELLED', ['#12'], ['pay-cn']) as unknown as Record<string, unknown>;
    cancelledNoList.payments = null;
    h.sdk.ordersList = [
      noPrice as never,
      badPrice as never,
      noPayments as never,
      cancelledNoList as never,
      order('ord-9', 'PAID', ['#12'], ['pay-9']),
    ];
    const r = await h.bridge.reconcile();
    assert.equal(r.error, undefined);
    assert.deepEqual([r.ran, r.paid, r.cancelled], [true, 1, 0]);
    assert.deepEqual(
      h.transport.of('payment.paid').map((m) => m.paymentId),
      ['pay-9'],
    );
  });

  it('COMPLETED 도 paid 로 처리하고, 미납금이 남았으면 fullyPaid:false 로 기록은 유지한다', async () => {
    const h = await withWatch();
    h.sdk.ordersList = [order('ord-9', 'COMPLETED', ['#12'], ['pay-9'], 30000, 30000)];
    await h.bridge.reconcile();
    const m = h.transport.of('payment.paid')[0]!;
    assert.equal(m.fullyPaid, false);
    assert.equal(m.paidValue, 30000);
    assert.equal(m.unpaidValue, 30000);
    assert.equal(watchEntries(h).length, 1);
  });

  it('이미 보낸 결제(gm.payments / 처리한 paymentId)는 다시 보내지 않는다', async () => {
    const h = await withWatch();
    h.sdk.setOrder('ord-1', 0, 60000);
    h.sdk.emitPaid('pay-1', 'ord-1'); // 이벤트로 이미 보냄
    await settle();
    h.transport.sent.length = 0;
    // 완납 보고가 기록을 지웠으니 다시 기록을 만든다
    await h.run(syncCmd(12, [line(12, 1, { unitPrice: 60000 })]));
    h.transport.sent.length = 0;
    h.sdk.ordersList = [order('ord-1', 'PAID', ['#12'], ['pay-1', 'pay-2'])];
    const r = await h.bridge.reconcile();
    assert.equal(r.paid, 1, 'pay-2 만');
    assert.deepEqual(
      h.transport.of('payment.paid').map((m) => m.paymentId),
      ['pay-2'],
    );
  });

  it('REFUNDED / CANCELLED 주문의 결제는 payment.cancelled 로 보낸다(이미 보낸 것 제외)', async () => {
    const h = await withWatch();
    h.sdk.emitCancel('pay-old', 'ord-r');
    await settle();
    h.transport.sent.length = 0;
    h.sdk.ordersList = [
      order('ord-r', 'REFUNDED', ['#12'], ['pay-old', 'pay-r1']),
      order('ord-c', 'CANCELLED', ['#12'], ['pay-c1']),
    ];
    const r = await h.bridge.reconcile();
    assert.equal(r.cancelled, 2);
    assert.deepEqual(
      h.transport.of('payment.cancelled').map((m) => m.paymentId),
      ['pay-r1', 'pay-c1'],
    );
    assert.deepEqual(watchEntries(h), [], '처리한 기록은 지운다');
  });

  it('호출 제한이면 15초 뒤 한 번만 다시 시도한다', async () => {
    const h = await withWatch();
    h.sdk.getOrdersFailures = [new FakeRateLimitError()];
    h.sdk.ordersList = [order('ord-9', 'PAID', ['#12'], ['pay-9'])];
    const p = h.bridge.reconcile();
    await settle();
    assert.equal(h.sdk.callsOf('order.getOrders').length, 1);
    await h.clock.advance(RECONCILE_RETRY_MS);
    const r = await p;
    assert.equal(h.sdk.callsOf('order.getOrders').length, 2);
    assert.equal(r.paid, 1);
  });

  it('호출 제한이 두 번 연속이면 포기한다(더 재시도하지 않는다)', async () => {
    const h = await withWatch();
    h.sdk.getOrdersFailures = [new FakeRateLimitError(), new FakeRateLimitError()];
    const p = h.bridge.reconcile();
    await h.clock.advance(RECONCILE_RETRY_MS);
    const r = await p;
    assert.equal(h.sdk.callsOf('order.getOrders').length, 2);
    assert.ok(r.error);
    await h.clock.advance(5 * RECONCILE_RETRY_MS);
    assert.equal(h.sdk.callsOf('order.getOrders').length, 2);
    assert.equal(watchEntries(h).length, 1, '기록은 남는다');
  });

  it('호출 제한이 아닌 오류는 재시도하지 않는다', async () => {
    const h = await withWatch();
    h.sdk.getOrdersFailures = [new Error('boom')];
    const r = await h.bridge.reconcile();
    assert.equal(h.sdk.callsOf('order.getOrders').length, 1);
    assert.match(r.error!, /boom/);
  });

  it('같은 결제를 두 번 조회해도(수동 버튼 연타) 중복으로 보내지 않는다', async () => {
    const h = await withWatch();
    h.sdk.ordersList = [order('ord-9', 'PAID', ['#12'], ['pay-9'], 30000, 30000)];
    await h.bridge.reconcile();
    await h.bridge.reconcile();
    assert.equal(h.transport.of('payment.paid').length, 1);
  });

  it('getView: 결제 알림과 처리 내역을 보여 준다', async () => {
    const h = await withWatch();
    h.sdk.ordersList = [order('ord-9', 'PAID', ['#12'], ['pay-9'])];
    await h.bridge.reconcile();
    const v = h.bridge.getView();
    assert.equal(v.payments[0]!.paymentId, 'pay-9');
    assert.equal(v.payments[0]!.sent, true);
    assert.equal(v.activity[0]!.result, 'added');
    assert.equal(v.cart[0]!.workOrderId, 12);
  });
});

// ---------------------------------------------------------------------------

describe('탭 수명 / 설정 저장 -> reloadSettings (PaymentRuntime)', () => {
  function makeRuntime(values: Record<string, string | boolean>) {
    const sdk = new FakeSdk();
    sdk.settingValues = { transport: 'ws', ...values };
    const clock = new FakeClock();
    const transports: FakeTransport[] = [];
    const urls: string[] = [];
    const logs: string[] = [];
    const runtime = createPaymentRuntime({
      sdk,
      clock,
      log: (_l, m) => logs.push(m),
      pluginVersion: '1.1.0',
      transportFactory: (ctx) => {
        urls.push(ctx.settings.serverUrl);
        const t = new FakeTransport();
        transports.push(t);
        return t;
      },
    });
    return { sdk, runtime, transports, urls, logs, clock };
  }

  it('이벤트를 만들 때 한 번만 등록하고, start() 를 여러 번 불러도 한 번만 시작한다', async () => {
    const { sdk, runtime, transports } = makeRuntime({ serverUrl: 'http://192.168.0.10:8765' });
    await Promise.all([runtime.start(), runtime.start()]);
    await settle();
    assert.equal(runtime.isRunning(), true);
    assert.equal(transports.length, 1);
    assert.equal(sdk.callsOf('draftOrder.get').length, 1, '초기 draft 캐시');
    assert.equal(sdk.callsOf('plugin.getPluginInfo').length, 1);
    assert.equal(sdk.callsOf('merchant.getMerchant').length, 1);
    // 이벤트 연결 확인: 결제 이벤트가 bridge 로 간다
    transports[0]!.goOnline();
    sdk.setOrder('o1', 0, 1000);
    sdk.emitPaid('p1', 'o1');
    await settle();
    assert.equal(transports[0]!.of('payment.paid').length, 1);
  });

  it('stop() 하면 전송 계층을 닫고, 다시 start() 하면 같은 clientId 로 새로 연결한다', async () => {
    const { sdk, runtime, transports } = makeRuntime({ serverUrl: 'http://192.168.0.10:8765' });
    await runtime.start();
    const clientId = runtime.bridge.getStatus().clientId;
    await runtime.stop();
    assert.equal(transports[0]!.stopped, true);
    assert.equal(runtime.isRunning(), false);
    await runtime.start();
    assert.equal(transports.length, 2);
    assert.equal(runtime.bridge.getStatus().clientId, clientId);
    assert.equal(sdk.store.get('gm.clientId'), clientId);
  });

  it('서버 주소(매장 토큰)가 없으면 시작하지 않는다', async () => {
    const { sdk, runtime, transports } = makeRuntime({ serverUrl: '' });
    await runtime.start();
    assert.equal(runtime.isRunning(), false);
    assert.equal(transports.length, 0);
    assert.deepEqual(sdk.toasts, [], '경고 토스트도 없다');
    const v = runtime.bridge.getView();
    assert.equal(v.running, false);
    assert.match(v.issue!, /매장 토큰/);
  });

  it('설정 저장(applySettings): 주소가 새로 생기면 시작하고, 바뀌면 전송 계층을 다시 만들고, 지우면 멈춘다', async () => {
    const { sdk, runtime, transports, urls } = makeRuntime({ serverUrl: '' });
    await runtime.start();
    assert.equal(runtime.isRunning(), false);

    sdk.settingValues = { ...sdk.settingValues, serverUrl: '192.168.0.10:8765' };
    await runtime.applySettings();
    assert.equal(runtime.isRunning(), true);
    assert.deepEqual(urls, ['http://192.168.0.10:8765']);

    sdk.settingValues = { ...sdk.settingValues, serverUrl: 'http://192.168.0.20:8765' };
    await runtime.applySettings();
    assert.equal(transports[0]!.stopped, true);
    assert.deepEqual(urls, ['http://192.168.0.10:8765', 'http://192.168.0.20:8765']);

    // 연결과 무관한 설정(알림 표시)만 바뀌면 다시 연결하지 않는다
    sdk.settingValues = { ...sdk.settingValues, showToast: false };
    await runtime.applySettings();
    assert.equal(urls.length, 2);

    sdk.settingValues = { ...sdk.settingValues, serverUrl: '' };
    await runtime.applySettings();
    assert.equal(runtime.isRunning(), false);
    assert.equal(transports[1]!.stopped, true);
  });
});
