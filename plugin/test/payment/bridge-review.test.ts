// 결제 화면 요청, 결제 메시지 보존, 명령 ack, 변경 실패 처리, 카탈로그 매칭, start() 완료 전 reloadSettings 에 대한 bridge 단위 테스트
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ServerMessage } from '../../src/payment/protocol.ts';
import { settle } from './fake-clock.ts';
import { catalogItem, deferred } from './fake-sdk.ts';
import type { Harness } from './harness.ts';
import { createHarness, line, syncCmd } from './harness.ts';
import { last } from './util.ts';

const WELCOME: ServerMessage = { type: 'welcome', serverVersion: '1.0.0', serverTime: '2026-11-03T09:00:00' };
const TIMEOUT_TEXT = 'draftOrder의 요청이 지연되고 있습니다 - draftOrder - draft-order.add-line-item.request - 30000ms';

function dtos(h: Harness) {
  return h.sdk.callsOf('draftOrder.addLineItem').map((c) => c.args[0] as { item: { id: number; category: { id: number } } });
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

describe('결제 화면 요청(startPayment)은 기다리지 않는다', () => {
  it('ack 를 먼저 보낸 뒤 startPayment 를 부르고, 응답이 없어도(대기 중이어도) 큐가 계속 처리된다', async () => {
    const h = await createHarness();
    const hang = deferred();
    let acksWhenCalled = -1;
    h.sdk.hooks.startPayment = () => {
      acksWhenCalled = h.transport.acks().length;
      return hang.promise; // 토스 에뮬레이터처럼 응답이 오지 않는다
    };

    await h.run(syncCmd(12, [line(12, 1)], { id: 'pay-cmd', startPayment: true }));
    assert.equal(h.sdk.callsOf('draftOrder.startPayment').length, 1);
    assert.equal(acksWhenCalled, 1, 'startPayment 를 부르는 시점에 ack 는 이미 나갔다');
    assert.deepEqual(h.transport.acks().map((a) => [a.commandId, a.ok]), [['pay-cmd', true]]);
    assert.deepEqual(h.sdk.toasts, [{ kind: 'success', message: '12가1234 홍길동 결제를 시작해요' }]);

    // startPayment 가 대기 중인 채로 다음 명령들이 계속 처리된다(다시 결제 시작 요청이 와도 마찬가지)
    await h.run(syncCmd(13, [line(13, 1)], { id: 'next-1' }));
    await h.run(syncCmd(14, [line(14, 1)], { id: 'next-2', startPayment: true }));
    assert.deepEqual(h.transport.acks().map((a) => [a.commandId, a.ok]), [
      ['pay-cmd', true],
      ['next-1', true],
      ['next-2', true],
    ]);
    assert.deepEqual(h.sdk.logicalKeys(), ['gm-14-1']);
    assert.equal(h.sdk.callsOf('draftOrder.startPayment').length, 2);
    assert.equal(h.bridge.getStatus().queued, 0);
  });

  it('SDK 가 30초 뒤 타임아웃 오류로 끝내도 ack/토스트/서버 로그에 영향이 없고 로컬 로그만 남긴다', async () => {
    const h = await createHarness();
    const hang = deferred();
    h.sdk.hooks.startPayment = () => hang.promise;
    await h.run(syncCmd(12, [line(12, 1)], { startPayment: true }));
    const acksBefore = h.transport.acks().length;
    const toastsBefore = h.sdk.toasts.length;

    hang.reject(new Error('draftOrder의 요청이 지연되고 있습니다 - draftOrder - draft-order.start-payment - 30000ms'));
    await settle();
    assert.equal(h.transport.acks().length, acksBefore);
    assert.equal(h.sdk.toasts.length, toastsBefore);
    assert.equal(h.transport.of('log').length, 0, '타임아웃은 서버로 보고하지 않는다');
    assert.ok(h.logs.some(([lvl, msg]) => lvl === 'warn' && /응답이 없어요/.test(msg)));
  });

  it('결제 조건(설정 끔 / 빈 lines)이 아니면 startPayment 를 부르지 않는 것은 그대로다', async () => {
    const h = await createHarness({ settings: { allowStartPayment: false } });
    await h.run(syncCmd(12, [line(12, 1)], { startPayment: true }));
    assert.equal(h.sdk.callsOf('draftOrder.startPayment').length, 0);
    const h2 = await createHarness();
    await h2.run(syncCmd(12, [], { startPayment: true }));
    assert.equal(h2.sdk.callsOf('draftOrder.startPayment').length, 0);
  });
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

describe('결제 메시지 보존과 welcome 뒤 재전송', () => {
  async function paidOnce(h: Harness, tag = '1') {
    h.sdk.setOrder(`ord-${tag}`, 0, 5000);
    await h.bridge.onPaid(`pay-${tag}`, `ord-${tag}`);
    await settle();
  }
  const storedPayments = (h: Harness) =>
    JSON.parse(h.sdk.store.get('gm.payments') ?? '[]') as { at: number; msg: { type: string; paymentId: string } }[];

  it('payment.paid / payment.cancelled 를 발생 즉시 보내고 storage(gm.payments)에도 저장한다', async () => {
    const h = await createHarness();
    await paidOnce(h);
    h.bridge.onCancel('pay-9', 'ord-9');
    await settle();
    assert.deepEqual(h.transport.sent.map((m) => m.type), ['payment.paid', 'payment.cancelled']);
    const stored = storedPayments(h);
    assert.deepEqual(stored.map((p) => [p.msg.type, p.msg.paymentId]), [
      ['payment.paid', 'pay-1'],
      ['payment.cancelled', 'pay-9'],
    ]);
    assert.equal(stored[0]!.at, h.clock.now());
  });

  it('welcome 을 받을 때마다 보존된 결제 메시지를 전부 다시 보낸다', async () => {
    const h = await createHarness();
    await paidOnce(h);
    h.bridge.onCancel('pay-9', 'ord-9');
    h.transport.sent.length = 0;

    h.transport.serverSend(WELCOME);
    assert.deepEqual(h.transport.sent.map((m) => [m.type, 'paymentId' in m ? m.paymentId : '']), [
      ['payment.paid', 'pay-1'],
      ['payment.cancelled', 'pay-9'],
    ]);
    h.transport.sent.length = 0;
    h.transport.serverSend(WELCOME); // 재연결 뒤의 welcome
    assert.equal(h.transport.sent.length, 2);
    const paid = h.transport.of('payment.paid')[0]!;
    assert.equal(paid.fullyPaid, true);
    assert.equal(paid.paidValue, 5000);
  });

  it('보존한 결제가 없으면 welcome 에 아무것도 보내지 않는다', async () => {
    const h = await createHarness();
    h.transport.serverSend(WELCOME);
    assert.equal(h.transport.sent.length, 0);
  });

  it('최근 20개만 보존한다', async () => {
    const h = await createHarness();
    for (let i = 0; i < 25; i++) h.bridge.onCancel(`pay-${i}`, 'ord-1');
    await settle();
    const stored = storedPayments(h);
    assert.equal(stored.length, 20);
    assert.equal(stored[0]!.msg.paymentId, 'pay-5');
    assert.equal(stored[19]!.msg.paymentId, 'pay-24');
    h.transport.sent.length = 0;
    h.transport.serverSend(WELCOME);
    assert.equal(h.transport.of('payment.cancelled').length, 20);
  });

  it('24시간이 지난 것은 재전송하지 않고 저장소에서도 지운다 (정확히 24시간은 포함)', async () => {
    const h = await createHarness();
    h.bridge.onCancel('pay-old', 'ord-1');
    await h.clock.advance(12 * 60 * 60_000);
    h.bridge.onCancel('pay-mid', 'ord-1');
    await h.clock.advance(12 * 60 * 60_000); // pay-old 는 정확히 24시간
    h.transport.sent.length = 0;
    h.transport.serverSend(WELCOME);
    assert.deepEqual(h.transport.of('payment.cancelled').map((m) => m.paymentId), ['pay-old', 'pay-mid']);

    await h.clock.advance(1); // pay-old 는 24시간 + 1ms
    h.transport.sent.length = 0;
    h.transport.serverSend(WELCOME);
    await settle();
    assert.deepEqual(h.transport.of('payment.cancelled').map((m) => m.paymentId), ['pay-mid']);
    assert.deepEqual(storedPayments(h).map((p) => p.msg.paymentId), ['pay-mid']);
  });

  it('같은 (종류, paymentId) 는 한 번만 보존한다', async () => {
    const h = await createHarness();
    h.bridge.onCancel('pay-1', 'ord-1');
    h.bridge.onCancel('pay-1', 'ord-1');
    await settle();
    assert.equal(storedPayments(h).length, 1);
  });

  it('오프라인이어도 보존되고, 다시 연결돼 welcome 을 받으면 보낸다', async () => {
    const h = await createHarness();
    h.transport.goOffline();
    await paidOnce(h);
    assert.equal(h.transport.sent.length, 0);
    assert.equal(storedPayments(h).length, 1);
    h.transport.goOnline(); // 버퍼 flush
    assert.equal(h.transport.of('payment.paid').length, 1);
    h.transport.serverSend(WELCOME); // 서버가 못 받았을 수도 있으니 한 번 더(서버가 paymentId 로 중복 제거)
    assert.equal(h.transport.of('payment.paid').length, 2);
  });

  it('플러그인을 다시 시작해도(같은 storage) 보존된 결제를 welcome 뒤에 다시 보내고, 같은 paid 이벤트에 getOrder 를 다시 부르지 않는다', async () => {
    const h1 = await createHarness();
    await paidOnce(h1);
    await h1.bridge.stop();

    const h2 = await createHarness({ sdk: h1.sdk, clock: h1.clock, wire: false });
    h2.transport.serverSend(WELCOME);
    assert.deepEqual(h2.transport.of('payment.paid').map((m) => m.paymentId), ['pay-1']);
    h1.sdk.resetCalls();
    await h2.bridge.onPaid('pay-1', 'ord-1');
    assert.equal(h1.sdk.callsOf('order.getOrder').length, 0);
  });

  it('손상된 저장 값은 무시하고 정상 동작한다', async () => {
    for (const bad of ['not json', '{"a":1}', '[1,"x",{"at":1}]', '[{"at":"x","msg":{}}]']) {
      const h0 = await createHarness({ start: false });
      h0.sdk.store.set('gm.payments', bad);
      await h0.bridge.start();
      await settle();
      h0.transports[0]!.goOnline();
      h0.transports[0]!.serverSend(WELCOME);
      assert.equal(h0.transports[0]!.sent.length, 0, bad);
    }
  });

  it('저장소를 쓸 수 없어도 전송은 된다', async () => {
    const h = await createHarness();
    h.sdk.failStorage = true;
    await paidOnce(h);
    assert.equal(h.transport.of('payment.paid').length, 1);
    assert.ok(h.logs.some(([lvl, msg]) => lvl === 'warn' && /결제 보존 기록을 저장하지 못했어요/.test(msg)));
  });
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

describe('hello 의 processedIds 는 ok:true 로 끝난 명령만', () => {
  it('실패한 명령은 빠지고(superseded 처리는 ok:true 라 포함), 서버가 다시 보내면 저장된 ok:false ack 를 다시 보낸다', async () => {
    const h = await createHarness();
    h.sdk.hooks.addLineItem = (dto) => {
      if (dto.key.startsWith('gm-2-')) throw new Error('이 상품은 담을 수 없어요');
    };
    const good = syncCmd(1, [line(1, 1)], { id: 'good' });
    const bad = syncCmd(2, [line(2, 1)], { id: 'bad' });
    await h.run(good);
    await h.run(bad);
    h.transport.sendCommand(syncCmd(5, [line(5, 1)], { id: 'sup-a' }));
    h.transport.sendCommand(syncCmd(5, [line(5, 1), line(5, 2)], { id: 'sup-b' }));
    await settle();

    assert.equal(h.ackFor('bad')!.ok, false);
    assert.equal(h.ackFor('sup-a')!.superseded, true);
    assert.deepEqual(h.ctxs[0]!.getHello('ws').processedIds, ['good', 'sup-a', 'sup-b']);
    // 저장소에는 실패한 명령도 남아 있다(재전송 시 같은 ack 를 돌려주려고)
    const stored = JSON.parse(h.sdk.store.get('gm.processed')!) as { id: string; ok: boolean }[];
    assert.deepEqual(stored.map((e) => [e.id, e.ok]), [
      ['good', true],
      ['bad', false],
      ['sup-a', true],
      ['sup-b', true],
    ]);

    // 서버는 'bad' 가 processedIds 에 없으니 다시 보낸다 -> 다시 처리하지 않고 저장된 ok:false ack 를 보낸다
    h.sdk.resetCalls();
    await h.run(bad);
    const acks = h.transport.acks().filter((a) => a.commandId === 'bad');
    assert.equal(acks.length, 2);
    assert.equal(acks[1]!.ok, false);
    assert.match(acks[1]!.error!, /담을 수 없어요/);
    assert.deepEqual(h.sdk.callNames('draftOrder.'), [], '다시 처리하지 않는다');
  });

  it('HELLO_PROCESSED_MAX(50) 는 ok:true 인 것만 세어 최근 50개', async () => {
    const h = await createHarness();
    h.sdk.hooks.addLineItem = (dto) => {
      if (dto.key.startsWith('gm-9999-')) throw new Error('실패');
    };
    for (let i = 1; i <= 60; i++) h.transport.sendCommand(syncCmd(i, [], { id: `ok-${i}` }));
    await settle(5);
    h.transport.sendCommand(syncCmd(9999, [line(9999, 1)], { id: 'bad-last' }));
    await settle(5);
    const ids = h.ctxs[0]!.getHello('ws').processedIds;
    assert.equal(ids.length, 50);
    assert.equal(ids[0], 'ok-11');
    assert.equal(last(ids), 'ok-60');
    assert.ok(!ids.includes('bad-last'));
  });
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

describe('변경 메서드 실패 시 캐시 draft 폐기 / 타임아웃 재시도 금지', () => {
  it('addLineItem 이 실패하면 캐시를 버리고(ack 의 draft 는 null), 다음 명령은 get() 으로 실제 상태를 새로 읽는다', async () => {
    const h = await createHarness();
    await h.run(syncCmd(1, [line(1, 1)]));
    assert.equal(h.sdk.callsOf('draftOrder.get').length, 2, '시작 get + 검증 get');

    let fail = true;
    h.sdk.hooks.addLineItem = () => {
      if (fail) throw new Error('실패');
    };
    await h.run(syncCmd(2, [line(2, 1)], { id: 'bad' }));
    assert.equal(h.lastAck().ok, false);
    assert.equal(h.lastAck().draft, null, '캐시가 없으니 ack 의 draft 도 null');
    assert.equal(h.sdk.callsOf('draftOrder.get').length, 3, '실패한 명령 안에서는 시작할 때 한 번만 읽는다');

    fail = false;
    await h.run(syncCmd(3, [line(3, 1)]));
    assert.equal(h.sdk.callsOf('draftOrder.get').length, 5, '명령마다 시작 get + 검증 get (캐시를 쓰지 않는다)');
    await h.run(syncCmd(3, [line(3, 1), line(3, 2)]));
    assert.equal(h.sdk.callsOf('draftOrder.get').length, 7);
    assert.deepEqual(h.sdk.logicalKeys(), ['gm-3-1', 'gm-3-2']);
  });

  it('deleteLineItem 실패도 캐시를 버리고, 다시 보내면 실제 상태에서 이어서 맞춘다', async () => {
    const h = await createHarness();
    await h.run(syncCmd(1, [line(1, 1), line(1, 2)]));
    h.sdk.hooks.deleteLineItem = () => {
      throw new Error('삭제 실패');
    };
    // 수량이 바뀌면 updateItemQuantity 가 아니라 삭제 후 다시 담는다
    await h.run(syncCmd(1, [line(1, 1, { quantity: 4 }), line(1, 2)]));
    assert.equal(h.lastAck().ok, false);
    assert.equal(h.sdk.callsOf('draftOrder.updateItemQuantity').length, 0);
    h.sdk.hooks.deleteLineItem = undefined;
    await h.run(syncCmd(1, [line(1, 1, { quantity: 4 }), line(1, 2)]));
    assert.equal(h.lastAck().ok, true);
    assert.deepEqual(h.sdk.logicalKeys().sort(), ['gm-1-1', 'gm-1-2']);
    assert.equal(h.sdk.lines.find((l) => l.key.startsWith('gm-1-1'))!.quantity, 4);
  });

  it('타임아웃 뒤에는 get() 이 POS 의 실제 상태를 알려 주므로, 이미 반영된 라인을 중복해서 담지 않는다', async () => {
    const h = await createHarness();
    let applied = false;
    h.sdk.hooks.addLineItem = (dto) => {
      if (applied) return;
      applied = true;
      // POS 는 라인을 담았지만 응답이 늦어 SDK 가 타임아웃 오류를 낸 상황
      h.sdk.lines.push({
        key: dto.key,
        item: { id: 0, title: dto.item.title, category: dto.item.category },
        itemPrice: { priceValue: dto.itemPrice.priceValue },
        quantity: dto.quantity,
      });
      throw new Error(TIMEOUT_TEXT);
    };
    await h.run(syncCmd(12, [line(12, 1)], { id: 'slow' }));
    assert.equal(h.lastAck().ok, false);
    assert.match(h.lastAck().error!, /지연/);

    await h.run(syncCmd(12, [line(12, 1)], { id: 'again' })); // 사용자가 다시 담기
    assert.equal(h.lastAck().ok, true);
    assert.equal(h.sdk.callsOf('draftOrder.addLineItem').length, 1, '이미 있는 라인이니 다시 담지 않는다');
    assert.deepEqual(h.sdk.logicalKeys(), ['gm-12-1']);
  });

  it('타임아웃 오류(메시지에 "지연")는 카테고리/미등록 재시도를 하지 않는다', async () => {
    const h = await createHarness();
    h.sdk.hooks.addLineItem = () => {
      throw new Error(TIMEOUT_TEXT);
    };
    await h.run(syncCmd(12, [line(12, 1)]));
    assert.equal(dtos(h).length, 1, '미등록 상품이어도 카테고리 폴백 없음');
    assert.equal(h.sdk.callsOf('category.getCategories').length, 0);
    assert.equal(h.lastAck().ok, false);
    assert.match(h.lastAck().error!, /지연/);
  });

  it('매칭 상품 추가가 타임아웃이면 미등록 상품으로 재시도하지 않는다', async () => {
    const h = await createHarness();
    h.sdk.catalogItems = [catalogItem({ id: 501, title: 'POS 오일', code: 'ENG-OIL-S' })];
    h.sdk.hooks.addLineItem = () => {
      throw new Error(TIMEOUT_TEXT);
    };
    await h.run(syncCmd(12, [line(12, 1, { productCode: 'ENG-OIL-S' })]));
    assert.deepEqual(dtos(h).map((d) => d.item.id), [501]);
    assert.equal(h.lastAck().ok, false);
  });

  it('카테고리 폴백 중 첫 시도가 실패해 캐시를 버려도 재시도가 성공하면 정상 상태로 돌아온다', async () => {
    const h = await createHarness();
    h.sdk.hooks.addLineItem = (dto) => {
      if (dto.item.category.id === 0) throw new Error('카테고리를 찾을 수 없어요');
    };
    await h.run(syncCmd(12, [line(12, 1), line(12, 2)]));
    assert.equal(h.lastAck().ok, true);
    assert.deepEqual(h.lastAck().draft!.ourKeys, ['gm-12-1', 'gm-12-2']);
    assert.equal(h.sdk.callsOf('draftOrder.get').length, 2, '시작 get + 검증 get 뿐(재시도 때문에 더 읽지 않는다)');
  });
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

describe('카탈로그 매칭은 판매 중(ON_SALE)인 상품만', () => {
  it('SOLD_OUT / UNAVAILABLE / DELETED / 상태 없음은 매칭하지 않고 판매 중 첫 상품(c)으로 담는다', async () => {
    const h = await createHarness();
    h.sdk.catalogItems = [
      catalogItem({ id: 501, title: '판매중', code: 'A' }),
      catalogItem({ id: 502, title: '품절', code: 'B', state: 'SOLD_OUT' }),
      catalogItem({ id: 503, title: '판매불가', code: 'C', state: 'UNAVAILABLE' }),
      catalogItem({ id: 504, title: '삭제', code: 'D', state: 'DELETED' }),
      catalogItem({ id: 505, title: '상태없음', code: 'E', state: undefined }),
    ];
    await h.run(
      syncCmd(
        12,
        ['A', 'B', 'C', 'D', 'E'].map((code, i) => line(12, i + 1, { productCode: code })),
      ),
    );
    assert.deepEqual(dtos(h).map((d) => d.item.id), [501, 501, 501, 501, 501]);
    assert.equal(h.lastAck().ok, true);
  });

  it('같은 코드가 품절 상품과 판매 중 상품에 모두 있으면 판매 중인 쪽을 쓴다', async () => {
    const h = await createHarness();
    h.sdk.catalogItems = [
      catalogItem({ id: 601, title: '품절', code: 'X', state: 'SOLD_OUT' }),
      catalogItem({ id: 602, title: '판매중', code: 'X' }),
    ];
    await h.run(syncCmd(12, [line(12, 1, { productCode: 'X' })]));
    assert.deepEqual(dtos(h).map((d) => d.item.id), [602]);
  });
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

describe('start() 완료 전의 reloadSettings 는 무시', () => {
  it('start() 호출 전의 reloadSettings / 설정 변경 이벤트는 아무것도 하지 않는다', async () => {
    const h = await createHarness({ start: false });
    await h.bridge.reloadSettings();
    h.sdk.emitSettingChange();
    await settle();
    assert.equal(h.sdk.callsOf('setting.getValues').length, 0);
    assert.equal(h.transports.length, 0);
    assert.deepEqual(h.sdk.toasts, []);

    await h.bridge.start();
    assert.equal(h.sdk.callsOf('setting.getValues').length, 1);
    assert.equal(h.transports.length, 1);
    // 시작이 끝난 뒤에는 평소처럼 동작한다
    h.sdk.settingValues = { ...h.sdk.settingValues, serverUrl: 'http://other:1' };
    h.sdk.emitSettingChange();
    await settle();
    assert.equal(h.transports.length, 2);
  });

  it('start() 가 clientId 를 읽는 중에 온 변경 이벤트로 clientId 없이 전송 계층이 시작되지 않는다', async () => {
    const h = await createHarness({ start: false });
    const gate = deferred();
    const realGet = h.sdk.storage.get;
    h.sdk.storage.get = async (key) => {
      await gate.promise;
      return realGet(key);
    };
    const starting = h.bridge.start();
    await settle();
    h.sdk.emitSettingChange();
    await h.bridge.reloadSettings();
    await settle();
    assert.equal(h.transports.length, 0);
    assert.equal(h.sdk.callsOf('setting.getValues').length, 0);

    gate.resolve();
    await starting;
    await settle();
    assert.equal(h.transports.length, 1);
    assert.equal(h.sdk.callsOf('setting.getValues').length, 1);
    assert.equal(h.ctxs[0]!.clientId, 'pos-test-client-0001');
  });

  it('stop() 뒤의 reloadSettings 도 무시한다', async () => {
    const h = await createHarness();
    await h.bridge.stop();
    const before = h.sdk.callsOf('setting.getValues').length;
    await h.bridge.reloadSettings();
    assert.equal(h.sdk.callsOf('setting.getValues').length, before);
  });
});
