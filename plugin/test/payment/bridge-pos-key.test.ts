// POS key 분리(논리 key + _nonce), 명령마다 실제 상태 읽기, 결제 전 장바구니 검증.
// 과거에 실제로 있었던 문제: 같은 key 가 두 줄씩 쌓이고 수량이 불어난 장바구니로 결제 화면이 열렸다.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CART_MISMATCH_MESSAGE } from '../../src/payment/bridge.ts';
import { logicalKeyOf } from '../../src/payment/protocol.ts';
import type { DraftLike } from '../../src/payment/sdk-types.ts';
import type { FakeSdk } from './fake-sdk.ts';
import { clearCmd, createHarness, line, syncCmd } from './harness.ts';

const POS_KEY_RE = /^gm-\d+-\d+_[A-Za-z0-9]{8}$/;

/** POS 에서 관찰된 옛 중복 장바구니(같은 key 두 줄씩, 수량이 불어남) */
function seedOldDuplicates(sdk: FakeSdk): void {
  sdk.addManualLine('gm-4-12', '상품12', 1, 120000);
  sdk.addManualLine('gm-4-12', '상품12', 3, 120000);
  sdk.addManualLine('gm-4-11', '상품11', 1, 40000);
  sdk.addManualLine('gm-4-11', '상품11', 7, 40000);
  sdk.addManualLine('gm-4-10', '상품10', 1, 69000);
  sdk.addManualLine('gm-4-10', '상품10', 11, 69000);
}

const wanted = () => [
  line(4, 10, { unitPrice: 69000, quantity: 1 }),
  line(4, 11, { unitPrice: 40000, quantity: 1 }),
  line(4, 12, { unitPrice: 120000, quantity: 1 }),
];

describe('옛 중복 draft 정리', () => {
  it('같은 key 두 줄씩 있는 draft 에 SYNC -> 논리 key 마다 정확히 1줄, 수량/단가가 맞고 새 key 는 _nonce 형식', async () => {
    const h = await createHarness();
    seedOldDuplicates(h.sdk);
    await h.run(syncCmd(4, wanted(), { startPayment: true }));

    assert.equal(h.lastAck().ok, true);
    assert.equal(h.sdk.lines.length, 3);
    for (const l of h.sdk.lines) assert.match(l.key, POS_KEY_RE);
    assert.deepEqual(h.sdk.logicalKeys().sort(), ['gm-4-10', 'gm-4-11', 'gm-4-12']);
    const byLogical = new Map(h.sdk.lines.map((l) => [logicalKeyOf(l.key)!, l]));
    assert.equal(byLogical.get('gm-4-10')!.quantity, 1);
    assert.equal(byLogical.get('gm-4-10')!.itemPrice.priceValue, 69000);
    assert.equal(byLogical.get('gm-4-11')!.quantity, 1);
    assert.equal(byLogical.get('gm-4-12')!.itemPrice.priceValue, 120000);
    assert.equal(h.sdk.snapshot().price.orderPriceValue, 229000);
    // 같은 posKey 가 두 줄이었으므로 각각 두 번씩 지웠다
    assert.deepEqual(h.sdk.deletedKeys().sort(), ['gm-4-10', 'gm-4-10', 'gm-4-11', 'gm-4-11', 'gm-4-12', 'gm-4-12']);
    assert.equal(h.sdk.callsOf('draftOrder.updateItemQuantity').length, 0);
    assert.equal(h.sdk.callsOf('draftOrder.startPayment').length, 1, '검증을 통과했으니 결제를 시작한다');
  });

  it('삭제 응답이 늦어(지운 뒤에도 남은 것으로 보여도) get() 으로 확인하고 넘어간다', async () => {
    const h = await createHarness();
    seedOldDuplicates(h.sdk);
    h.sdk.lateReturns = 6; // 삭제 6번 모두 변경 전 draft 를 돌려준다
    await h.run(syncCmd(4, wanted()));
    assert.equal(h.lastAck().ok, true);
    assert.equal(h.sdk.lines.length, 3);
    assert.deepEqual(h.sdk.logicalKeys().sort(), ['gm-4-10', 'gm-4-11', 'gm-4-12']);
  });

  it('CLEAR_CART 는 중복까지 모두 지우고 수동 라인은 남긴다', async () => {
    const h = await createHarness();
    h.sdk.addManualLine('manual-1', '직접', 2, 3000);
    seedOldDuplicates(h.sdk);
    await h.run(clearCmd());
    assert.equal(h.lastAck().ok, true);
    assert.deepEqual(h.sdk.lineKeys(), ['manual-1']);
    assert.equal(h.sdk.callsOf('draftOrder.deleteLineItem').length, 6);
  });

  it('CLEAR_CART 가 지워지지 않는 POS 에서는 명령이 실패한다', async () => {
    const h = await createHarness();
    seedOldDuplicates(h.sdk);
    h.sdk.draftOrder.deleteLineItem = async () => h.sdk.snapshot(); // 아무것도 지우지 않음
    await h.run(clearCmd());
    assert.equal(h.lastAck().ok, false);
    assert.match(h.lastAck().error!, /지우지 못했어요/);
  });
});

describe('POS 응답이 늦어도 get() 으로 확인한다', () => {
  it('addLineItem 이 새 라인이 없는 늦은 draft 를 돌려줘도 get() 에 있으면 성공한다', async () => {
    const h = await createHarness();
    h.sdk.lateReturns = 1;
    await h.run(syncCmd(12, [line(12, 1)]));
    assert.equal(h.lastAck().ok, true);
    assert.equal(h.sdk.lines.length, 1);
    assert.match(h.sdk.lines[0]!.key, POS_KEY_RE);
    assert.equal(h.sdk.callsOf('draftOrder.addLineItem').length, 1, '다시 담지 않는다');
    assert.deepEqual(h.lastAck().draft!.ourKeys, ['gm-12-1']);
  });
});

describe('결제 전 장바구니 검증', () => {
  it('검증이 계속 실패하는 POS -> 명령 실패, startPayment 를 부르지 않고 활동 기록은 failed', async () => {
    const h = await createHarness();
    // get() 이 항상 수량이 하나 많은 draft 를 돌려준다
    h.sdk.getTransform = (d: DraftLike): DraftLike => ({
      ...d,
      lineItems: d.lineItems.map((l) => ({ ...l, quantity: l.quantity + 1 })),
    });
    await h.run(syncCmd(12, [line(12, 1)], { startPayment: true }));
    const ack = h.lastAck();
    assert.equal(ack.ok, false);
    assert.equal(ack.error, CART_MISMATCH_MESSAGE);
    assert.equal(h.sdk.callsOf('draftOrder.startPayment').length, 0);
    assert.equal(h.bridge.getView().activity[0]!.result, 'failed');
    assert.ok(h.sdk.toasts.some((t) => t.kind === 'error'));
  });

  it('한 번 틀렸다가 다시 맞추면 통과한다', async () => {
    const h = await createHarness();
    let n = 0;
    h.sdk.getTransform = (d: DraftLike): DraftLike => {
      // 시작 get(1), 첫 검증 get(2)만 틀린 값
      n++;
      if (n !== 2) return d;
      return { ...d, lineItems: d.lineItems.map((l) => ({ ...l, quantity: l.quantity + 1 })) };
    };
    await h.run(syncCmd(12, [line(12, 1)], { startPayment: true }));
    assert.equal(h.lastAck().ok, true);
    assert.equal(h.sdk.callsOf('draftOrder.startPayment').length, 1);
    assert.equal(h.sdk.lines.length, 1);
  });
});

describe('보고는 논리 key', () => {
  it('ack 와 draft 보고의 key 는 gm-{작업ID}-{라인ID} 이고 POS 에는 _nonce 가 붙는다', async () => {
    const h = await createHarness();
    await h.run(syncCmd(12, [line(12, 1), line(12, 2)]));
    for (const l of h.sdk.lines) assert.match(l.key, POS_KEY_RE);
    const d = h.lastAck().draft!;
    assert.deepEqual(d.ourKeys, ['gm-12-1', 'gm-12-2']);
    assert.deepEqual(d.lines.map((l) => l.key), ['gm-12-1', 'gm-12-2']);
    assert.deepEqual(d.workOrderIds, [12]);

    await h.clock.advance(3000);
    h.sdk.addManualLine('manual-9', '직접', 1, 500, true);
    await h.clock.advance(0);
    const drafts = h.transport.of('draft');
    assert.equal(drafts.length, 1);
    assert.deepEqual(drafts[0]!.draft.ourKeys, ['gm-12-1', 'gm-12-2']);
  });

  it('뷰의 장바구니도 작업 ID 로 묶인다', async () => {
    const h = await createHarness();
    await h.run(syncCmd(12, [line(12, 1), line(12, 2)]));
    const view = h.bridge.getView();
    assert.equal(view.cart.length, 1);
    assert.equal(view.cart[0]!.workOrderId, 12);
    assert.equal(view.cart[0]!.lines.length, 2);
  });
});

describe('범위: exclusive / non-exclusive (옛 중복 포함)', () => {
  function seedTwoWorks(h: { sdk: FakeSdk }): void {
    h.sdk.addManualLine('manual-1', '직접', 1, 1000);
    h.sdk.addManualLine('gm-4-10', '상품10', 1, 69000);
    h.sdk.addManualLine('gm-4-10', '상품10', 5, 69000);
    h.sdk.addManualLine('gm-5-1', '다른작업', 2, 5000);
    h.sdk.addManualLine('gm-5-1', '다른작업', 2, 5000);
  }

  it('exclusive:false 이면 이 작업의 중복만 정리하고 다른 작업/수동 라인은 그대로', async () => {
    const h = await createHarness();
    seedTwoWorks(h);
    await h.run(syncCmd(4, [line(4, 10, { unitPrice: 69000 })], { exclusive: false }));
    assert.equal(h.lastAck().ok, true);
    assert.deepEqual(h.sdk.logicalKeys().sort(), ['gm-4-10', 'gm-5-1', 'gm-5-1', 'manual-1']);
    assert.equal(h.sdk.lines.filter((l) => l.key === 'gm-5-1').length, 2, '다른 작업은 건드리지 않는다');
  });

  it('exclusive:true 이면 다른 작업의 gm- 라인도 모두 지우고 수동 라인만 남긴다', async () => {
    const h = await createHarness();
    seedTwoWorks(h);
    await h.run(syncCmd(4, [line(4, 10, { unitPrice: 69000 })], { exclusive: true }));
    assert.equal(h.lastAck().ok, true);
    assert.deepEqual(h.sdk.logicalKeys().sort(), ['gm-4-10', 'manual-1']);
  });
});

describe('nonce', () => {
  it('기본 nonce 는 영숫자 8자이고 매번 다르다', async () => {
    const h = await createHarness({ bridge: { randomNonce: undefined } });
    const lines = Array.from({ length: 30 }, (_, i) => line(12, i + 1));
    await h.run(syncCmd(12, lines));
    assert.equal(h.lastAck().ok, true);
    const keys = h.sdk.lineKeys();
    assert.equal(keys.length, 30);
    for (const k of keys) assert.match(k, POS_KEY_RE);
    assert.equal(new Set(keys.map((k) => k.split('_')[1])).size, 30, 'nonce 가 모두 다르다');

    // 같은 라인을 다시 담아도(수량 변경) 새 key
    const before = h.sdk.lineKeys()[0]!;
    await h.run(syncCmd(12, [line(12, 1, { quantity: 2 }), ...lines.slice(1)]));
    assert.equal(h.lastAck().ok, true);
    assert.ok(!h.sdk.lineKeys().includes(before), '옛 key 는 재사용하지 않는다');
  });

  it('주입한 nonce 생성기를 쓴다', async () => {
    const h = await createHarness({ bridge: { randomNonce: () => 'ZZZZ0000' } });
    await h.run(syncCmd(12, [line(12, 1)]));
    assert.deepEqual(h.sdk.lineKeys(), ['gm-12-1_ZZZZ0000']);
  });
});
