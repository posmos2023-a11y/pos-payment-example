import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { KEYMAP_KEY, KEYMAP_MAX, NO_CATALOG_MESSAGE } from '../../src/payment/bridge.ts';
import { buildLineItemDto, stripNullI18n } from '../../src/payment/lineitem.ts';
import { logicalKeyOf, makeLineMemo, parseLineMemo } from '../../src/payment/protocol.ts';
import type { CatalogItemLike, LineItemDto } from '../../src/payment/sdk-types.ts';
import { settle } from './fake-clock.ts';
import { FakeRateLimitError, catalogItem } from './fake-sdk.ts';
import { clearCmd, createHarness, line, syncCmd } from './harness.ts';
import { last } from './util.ts';

function addedDtos(h: { sdk: { callsOf(n: string): { args: unknown[] }[] } }): LineItemDto[] {
  return h.sdk.callsOf('draftOrder.addLineItem').map((c) => c.args[0] as LineItemDto);
}

describe('SYNC_CART: 추가', () => {
  it('새 라인은 addLineItem 으로 들어가고(밑판=POS 상품 원본, memo=#작업ID 라벨) ack(ok) 에 draft 요약이 실린다', async () => {
    const h = await createHarness();
    h.sdk.catalogItems = [
      catalogItem({
        id: 501,
        title: 'POS 엔진오일',
        code: 'ENG-OIL-S',
        category: { id: 3, title: '소모품' },
        price: { title: '일반', sku: 'X1' },
        ...({ merchantId: 77, color: 'red' } as object),
      }),
    ];
    const cmd = syncCmd(12, [
      line(12, 1, { productCode: 'ENG-OIL-S', title: '엔진오일 교환(합성유)', unitPrice: 69000, quantity: 2 }),
      line(12, 2, { productCode: 'LAB-CHECK', title: '기본 점검 공임', category: '공임', unitPrice: 10000, taxFree: true }),
    ]);
    await h.run(cmd);

    const dtos = addedDtos(h);
    assert.equal(dtos.length, 2);
    const first = dtos[0]! as unknown as {
      key: string;
      item: Record<string, unknown>;
      itemPrice: Record<string, unknown>;
      [k: string]: unknown;
    };
    assert.match(first.key, /^gm-12-1_[A-Za-z0-9]{8}$/, 'POS key = 논리 key + _nonce');
    assert.equal(logicalKeyOf(first.key), 'gm-12-1');
    assert.equal(first.item.id, 501, '상품코드로 찾은 POS 상품이 밑판');
    assert.equal(first.item.merchantId, 77, '원본 객체의 나머지 필드도 그대로 들어간다');
    assert.equal(first.item.color, 'red');
    assert.equal(first.item.type, 'ITEM');
    assert.equal(first.item.title, '엔진오일 교환(합성유)', '이름은 전산 값');
    assert.deepEqual(first.item.category, { id: 3, title: '소모품' });
    assert.deepEqual(first.item.options, []);
    assert.equal(first.itemPrice.priceValue, 69000, '금액은 전산 값');
    assert.equal(first.itemPrice.title, '일반');
    assert.equal(first.itemPrice.sku, 'X1', '밑판 가격의 나머지 필드도 그대로');
    assert.equal(first.itemPrice.isTaxFree, false);
    assert.equal(first.quantity, 2);
    assert.equal(first.memo, '#12 12가1234 홍길동');
    assert.deepEqual(first.discount, []);
    assert.deepEqual(first.optionChoices, []);
    assert.equal(first.diningOption, 'HERE');
    // 두 번째는 코드가 없는 상품 -> (c) 첫 판매 상품(501) 밑판, 세금 없음 표시
    assert.equal(dtos[1]!.item.id, 501);
    assert.equal(dtos[1]!.item.title, '기본 점검 공임');
    assert.equal(dtos[1]!.itemPrice.isTaxFree, true);
    for (const dto of dtos) assert.equal('metadata' in dto, false);

    const ack = h.lastAck();
    assert.equal(ack.commandId, cmd.id);
    assert.equal(ack.ok, true);
    assert.equal(ack.superseded, undefined);
    assert.equal(ack.error, undefined);
    assert.deepEqual(ack.draft!.ourKeys, ['gm-12-1', 'gm-12-2']);
    assert.deepEqual(ack.draft!.workOrderIds, [12]);
    assert.equal(ack.draft!.lineCount, 2);
    assert.equal(ack.draft!.totalQuantity, 3);
    assert.match(ack.draft!.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(h.sdk.toasts, [{ kind: 'success', message: '12가1234 홍길동 상품 2건을 담았어요' }]);
  });

  it('명령마다 get() 으로 시작하고 get() 으로 검증한다(캐시를 쓰지 않는다)', async () => {
    const h = await createHarness();
    await h.run(syncCmd(12, [line(12, 1), line(12, 2)]));
    assert.deepEqual(h.sdk.callNames('draftOrder.'), [
      'draftOrder.get',
      'draftOrder.addLineItem',
      'draftOrder.addLineItem',
      'draftOrder.get',
    ]);
    await h.run(syncCmd(12, [line(12, 1, { quantity: 3 }), line(12, 2)]));
    assert.equal(h.sdk.callsOf('draftOrder.get').length, 4, '명령마다 시작 get + 검증 get');
  });

  it('초기 draft 캐시가 있어도 명령은 draftOrder.get() 으로 실제 상태를 읽는다', async () => {
    const h = await createHarness({ start: false });
    h.bridge.onDraftUpdate(h.sdk.snapshot());
    await h.bridge.start();
    h.transport.goOnline();
    await h.run(syncCmd(12, [line(12, 1)]));
    assert.equal(h.sdk.callsOf('draftOrder.get').length, 2, '시작 get + 검증 get');
    assert.equal(h.lastAck().ok, true);
  });

  it('productCode 가 비어 있어도 밑판 상품으로 담긴다(null i18n 은 지워진다)', async () => {
    const h = await createHarness();
    await h.run(syncCmd(12, [line(12, 1, { productCode: '', category: '' })]));
    const dto = addedDtos(h)[0]!;
    assert.equal(dto.item.id, 900, '기본 상품');
    assert.equal(h.lastAck().ok, true);
  });
});

describe('SYNC_CART: 수량/삭제/단가 변경', () => {
  it('수량이 다르면 updateItemQuantity 를 쓰지 않고 삭제 후 새 key 로 다시 담는다', async () => {
    const h = await createHarness();
    await h.run(syncCmd(12, [line(12, 1, { quantity: 1 })]));
    const oldKey = h.sdk.lines[0]!.key;
    h.sdk.resetCalls();
    await h.run(syncCmd(12, [line(12, 1, { quantity: 3 })]));
    assert.deepEqual(h.sdk.callNames('draftOrder.'), [
      'draftOrder.get',
      'draftOrder.deleteLineItem',
      'draftOrder.addLineItem',
      'draftOrder.get',
    ]);
    assert.equal(h.sdk.callsOf('draftOrder.updateItemQuantity').length, 0);
    assert.deepEqual(h.sdk.callsOf('draftOrder.deleteLineItem')[0]!.args, [oldKey]);
    assert.equal(h.sdk.lines.length, 1);
    assert.equal(h.sdk.lines[0]!.quantity, 3);
    assert.notEqual(h.sdk.lines[0]!.key, oldKey, '새 nonce');
    assert.equal(h.lastAck().draft!.totalQuantity, 3);
  });

  it('원하는 목록에 없는 gm- 라인은 deleteLineItem', async () => {
    const h = await createHarness();
    await h.run(syncCmd(12, [line(12, 1), line(12, 2)]));
    h.sdk.resetCalls();
    await h.run(syncCmd(12, [line(12, 1)]));
    assert.deepEqual(h.sdk.deletedKeys(), ['gm-12-2']);
    assert.deepEqual(h.sdk.logicalKeys(), ['gm-12-1']);
    assert.equal(h.sdk.callsOf('draftOrder.addLineItem').length, 0);
  });

  it('단가가 다르면 삭제 후 다시 추가', async () => {
    const h = await createHarness();
    await h.run(syncCmd(12, [line(12, 1, { unitPrice: 10000 })]));
    h.sdk.resetCalls();
    await h.run(syncCmd(12, [line(12, 1, { unitPrice: 12000 })]));
    assert.deepEqual(h.sdk.callNames('draftOrder.'), [
      'draftOrder.get',
      'draftOrder.deleteLineItem',
      'draftOrder.addLineItem',
      'draftOrder.get',
    ]);
    assert.equal(h.sdk.lines[0]!.itemPrice.priceValue, 12000);
    assert.equal(h.lastAck().draft!.orderPriceValue, 12000);
  });

  it('변경이 없으면 SDK 변경 호출을 하지 않는다', async () => {
    const h = await createHarness();
    const lines = [line(12, 1, { quantity: 2 }), line(12, 2)];
    await h.run(syncCmd(12, lines));
    h.sdk.resetCalls();
    await h.run(syncCmd(12, lines));
    assert.deepEqual(h.sdk.callNames('draftOrder.'), ['draftOrder.get', 'draftOrder.get'], '읽기만 한다');
    assert.equal(h.lastAck().ok, true);
  });

  it('lines 가 비면 우리 라인을 모두 뺀다', async () => {
    const h = await createHarness();
    await h.run(syncCmd(12, [line(12, 1), line(12, 2)]));
    await h.run(syncCmd(12, [], { label: '12가1234 홍길동' }));
    assert.deepEqual(h.sdk.logicalKeys(), []);
    assert.deepEqual(h.lastAck().draft!.ourKeys, []);
    assert.equal(last(h.sdk.toasts).message, '12가1234 홍길동 상품을 POS에서 뺐어요');
  });
});

describe('SYNC_CART: exclusive', () => {
  it('다른 작업(gm-)의 라인은 제거하고, POS 에서 직접 담은 라인은 절대 건드리지 않는다', async () => {
    const h = await createHarness();
    h.sdk.addManualLine('manual-1', '직접 담은 상품', 2, 3000);
    await h.run(syncCmd(5, [line(5, 1), line(5, 2)]));
    assert.deepEqual(h.sdk.logicalKeys(), ['manual-1', 'gm-5-1', 'gm-5-2']);
    h.sdk.resetCalls();

    await h.run(syncCmd(6, [line(6, 1)]));
    assert.deepEqual(h.sdk.deletedKeys(), ['gm-5-1', 'gm-5-2']);
    assert.deepEqual(h.sdk.logicalKeys(), ['manual-1', 'gm-6-1']);
    const manual = h.sdk.lines.find((l) => l.key === 'manual-1')!;
    assert.equal(manual.quantity, 2);
    assert.equal(manual.itemPrice.priceValue, 3000);
    assert.deepEqual(h.lastAck().draft!.workOrderIds, [6]);
    assert.equal(h.lastAck().draft!.lineCount, 2, '요약의 lineCount 에는 수동 라인도 포함');
  });

  it('exclusive:false + lines:[] ("POS에서 빼기"/"작업 취소"): 이 작업 라인만 지우고 다른 작업의 gm- 라인과 수동 라인은 남긴다', async () => {
    const h = await createHarness();
    h.sdk.addManualLine('manual-1', '직접 담은 상품', 2, 3000);
    await h.run(syncCmd(1, [line(1, 1), line(1, 2)]));
    await h.run(syncCmd(12, [line(12, 1)], { exclusive: false })); // 작업 1 과 12 가 함께 담겨 있음
    await h.run(syncCmd(7, [line(7, 1)], { exclusive: false }));
    assert.deepEqual(h.sdk.logicalKeys(), ['manual-1', 'gm-1-1', 'gm-1-2', 'gm-12-1', 'gm-7-1']);
    h.sdk.resetCalls();

    // 작업 1 을 POS 에서 뺀다: `gm-1-` 로 시작하는 것만 (gm-12-1 은 접두사만 비슷할 뿐 다른 작업)
    const cmd = syncCmd(1, [], { exclusive: false, startPayment: false });
    await h.run(cmd);
    assert.deepEqual(h.sdk.deletedKeys(), ['gm-1-1', 'gm-1-2']);
    assert.deepEqual(h.sdk.logicalKeys(), ['manual-1', 'gm-12-1', 'gm-7-1']);
    assert.equal(h.sdk.callsOf('draftOrder.addLineItem').length, 0);
    const ack = h.ackFor(cmd.id)!;
    assert.equal(ack.ok, true);
    assert.deepEqual(ack.draft!.workOrderIds, [7, 12]);

    // 같은 명령을 한 번 더(다른 id) 보내도 아무것도 지우지 않는다
    h.sdk.resetCalls();
    await h.run(syncCmd(1, [], { exclusive: false }));
    assert.deepEqual(h.sdk.callNames('draftOrder.'), ['draftOrder.get', 'draftOrder.get'], '읽기만 한다');
  });

  it('같은 lines:[] 라도 exclusive:true 이면 모든 gm- 라인을 지우되 수동 라인은 남긴다', async () => {
    const h = await createHarness();
    h.sdk.addManualLine('manual-1', '직접 담은 상품');
    await h.run(syncCmd(1, [line(1, 1)]));
    await h.run(syncCmd(2, [line(2, 1)], { exclusive: false }));
    await h.run(syncCmd(1, [], { exclusive: true }));
    assert.deepEqual(h.sdk.logicalKeys(), ['manual-1']);
  });

  it('exclusive:false 이면 같은 작업의 라인만 정리하고 다른 작업 라인은 남긴다', async () => {
    const h = await createHarness();
    await h.run(syncCmd(5, [line(5, 1), line(5, 2)]));
    await h.run(syncCmd(6, [line(6, 1)], { exclusive: false }));
    assert.deepEqual(h.sdk.logicalKeys(), ['gm-5-1', 'gm-5-2', 'gm-6-1']);
    await h.run(syncCmd(5, [line(5, 1)], { exclusive: false }));
    assert.deepEqual(h.sdk.logicalKeys(), ['gm-5-1', 'gm-6-1']);
    assert.deepEqual(h.lastAck().draft!.workOrderIds, [5, 6]);
  });
});

describe('SYNC_CART: startPayment', () => {
  it('startPayment && allowStartPayment && lines>0 일 때만 마지막에 startPayment 를 부른다', async () => {
    const h = await createHarness();
    await h.run(syncCmd(12, [line(12, 1)], { startPayment: true }));
    const names = h.sdk.callNames('draftOrder.');
    assert.equal(names[names.length - 1], 'draftOrder.startPayment');
    assert.equal(h.sdk.callsOf('draftOrder.startPayment').length, 1);
    assert.deepEqual(h.sdk.toasts, [{ kind: 'success', message: '12가1234 홍길동 결제를 시작해요' }]);
    assert.equal(h.lastAck().ok, true);
  });

  it('allowStartPayment 설정이 꺼져 있으면 담기만 한다', async () => {
    const h = await createHarness({ settings: { allowStartPayment: false } });
    await h.run(syncCmd(12, [line(12, 1)], { startPayment: true }));
    assert.equal(h.sdk.callsOf('draftOrder.startPayment').length, 0);
    assert.equal(h.sdk.callsOf('draftOrder.addLineItem').length, 1);
    assert.equal(h.sdk.toasts[0]!.message, '12가1234 홍길동 상품 1건을 담았어요');
  });

  it('lines 가 비어 있으면 결제를 시작하지 않는다', async () => {
    const h = await createHarness();
    await h.run(syncCmd(12, [], { startPayment: true }));
    assert.equal(h.sdk.callsOf('draftOrder.startPayment').length, 0);
    assert.equal(h.lastAck().ok, true);
  });

  it('startPayment:false 면 부르지 않는다', async () => {
    const h = await createHarness();
    await h.run(syncCmd(12, [line(12, 1)], { startPayment: false }));
    assert.equal(h.sdk.callsOf('draftOrder.startPayment').length, 0);
  });

  it('startPayment 가 실패해도 ack 는 ok:true 다: 결과는 이미 기록됐고 실패는 로그로만 남는다', async () => {
    const h = await createHarness();
    h.sdk.hooks.startPayment = () => {
      throw new Error('결제 화면을 열 수 없어요');
    };
    await h.run(syncCmd(12, [line(12, 1)], { startPayment: true }));
    const acks = h.transport.acks();
    assert.equal(acks.length, 1, 'ack 는 한 번뿐');
    assert.equal(acks[0]!.ok, true);
    assert.equal(acks[0]!.error, undefined);
    assert.deepEqual(h.sdk.logicalKeys(), ['gm-12-1']);
    assert.equal(h.sdk.toasts.filter((t) => t.kind === 'error').length, 0, '오류 토스트도 없다');
    assert.ok(h.logs.some(([lvl, msg]) => lvl === 'warn' && /결제 화면을 열지 못했어요.*결제 화면을 열 수 없어요/.test(msg)));
    assert.equal(h.transport.of('log').length, 1, '서버에는 warn 로그 한 건');
    assert.equal(h.transport.of('log')[0]!.level, 'warn');
  });
});

describe('SYNC_CART: POS 가 key 를 바꾼 경우(keyMap)', () => {
  it('새 key 를 찾아 기억하고 이후 조작에 POS key 를 쓰며, 보고는 우리 key 로 한다', async () => {
    const h = await createHarness();
    h.sdk.keyMode = 'rewrite';
    await h.run(syncCmd(12, [line(12, 1), line(12, 2)]));
    assert.deepEqual(h.sdk.lineKeys(), ['pos-1', 'pos-2']);
    const first = h.lastAck();
    assert.equal(first.ok, true);
    assert.deepEqual(first.draft!.ourKeys, ['gm-12-1', 'gm-12-2']);
    assert.deepEqual(first.draft!.workOrderIds, [12]);
    assert.deepEqual(first.draft!.lines.map((l) => l.key), ['gm-12-1', 'gm-12-2']);

    // 수량 변경: 기억한 POS key(pos-1)를 지우고 새로 담는다. 바뀌지 않은 라인은 건드리지 않는다.
    h.sdk.resetCalls();
    await h.run(syncCmd(12, [line(12, 1, { quantity: 3 }), line(12, 2)]));
    assert.equal(h.sdk.callsOf('draftOrder.updateItemQuantity').length, 0);
    assert.deepEqual(h.sdk.callsOf('draftOrder.deleteLineItem').map((c) => c.args[0]), ['pos-1']);
    assert.equal(h.sdk.callsOf('draftOrder.addLineItem').length, 1, '이미 있는 라인(gm-12-2)은 다시 담지 않는다');
    assert.deepEqual(h.sdk.lineKeys(), ['pos-2', 'pos-3']);
    assert.deepEqual(h.lastAck().draft!.ourKeys, ['gm-12-2', 'gm-12-1']);

    h.sdk.resetCalls();
    await h.run(syncCmd(12, [line(12, 1, { quantity: 3 })]));
    assert.deepEqual(h.sdk.callsOf('draftOrder.deleteLineItem').map((c) => c.args[0]), ['pos-2']);

    // 단가 변경: pos-3 삭제 후 다시 추가(새 POS key)
    h.sdk.resetCalls();
    await h.run(syncCmd(12, [line(12, 1, { quantity: 3, unitPrice: 20000 })]));
    assert.deepEqual(h.sdk.callsOf('draftOrder.deleteLineItem').map((c) => c.args[0]), ['pos-3']);
    assert.equal(h.sdk.callsOf('draftOrder.addLineItem').length, 1);
    const newPosKey = h.sdk.lines[0]!.key;
    assert.match(newPosKey, /^pos-\d+$/);

    // 우리 라인 비우기도 POS key 로
    h.sdk.resetCalls();
    await h.run(clearCmd());
    assert.deepEqual(h.sdk.callsOf('draftOrder.deleteLineItem').map((c) => c.args[0]), [newPosKey]);
    assert.deepEqual(h.sdk.lineKeys(), []);
  });

  it('draft update 이벤트의 요약도 우리 key 로 보고한다', async () => {
    const h = await createHarness();
    h.sdk.keyMode = 'rewrite';
    await h.run(syncCmd(12, [line(12, 1)]));
    await h.clock.advance(3000);
    h.sdk.addManualLine('manual-9', '직접', 1, 500, true);
    await h.clock.advance(0);
    const drafts = h.transport.of('draft');
    assert.equal(drafts.length, 1);
    assert.deepEqual(drafts[0]!.draft.ourKeys, ['gm-12-1']);
    assert.equal(drafts[0]!.draft.lineCount, 2);
  });

  it('addLineItem 결과에서 항목을 확인할 수 없으면 실패로 보고한다', async () => {
    const h = await createHarness();
    h.sdk.draftOrder.addLineItem = async () => h.sdk.snapshot(); // 아무것도 추가하지 않고 돌려줌
    await h.run(syncCmd(12, [line(12, 1)]));
    const ack = h.lastAck();
    assert.equal(ack.ok, false);
    assert.match(ack.error!, /확인하지 못했어요/);
  });
});

describe('CLEAR_CART', () => {
  it('gm- 라인만 삭제하고 수동 라인은 남긴다', async () => {
    const h = await createHarness();
    h.sdk.addManualLine('manual-1', '직접', 1, 1000);
    await h.run(syncCmd(5, [line(5, 1)]));
    await h.run(syncCmd(6, [line(6, 1)], { exclusive: false }));
    h.sdk.resetCalls();
    const cmd = clearCmd();
    await h.run(cmd);
    assert.deepEqual(h.sdk.deletedKeys(), ['gm-5-1', 'gm-6-1']);
    assert.deepEqual(h.sdk.logicalKeys(), ['manual-1']);
    const ack = h.lastAck();
    assert.equal(ack.commandId, cmd.id);
    assert.equal(ack.ok, true);
    assert.deepEqual(ack.draft!.ourKeys, []);
    assert.equal(ack.draft!.lineCount, 1);
  });
});

describe('addLineItem 밑판 선택 (a)상품코드 -> (b)기본 상품 코드 -> (c)첫 판매 상품', () => {
  function seed(h: Awaited<ReturnType<typeof createHarness>>): void {
    h.sdk.catalogItems = [
      catalogItem({ id: 504, title: '삭제된 상품', code: 'OLD', state: 'DELETED' }),
      catalogItem({ id: 501, title: 'POS 엔진오일', code: 'ENG-OIL-S', category: { id: 3, title: '소모품' }, price: { title: '기본', sku: 'X1' } }),
      catalogItem({ id: 502, title: 'POS 오일필터', category: { id: 4, title: '필터' }, price: { title: '일반', sku: 'FLT-OIL' } }),
      catalogItem({ id: 503, title: 'POS 에어필터', price: { title: '일반', barcode: '8801234' } }),
      catalogItem({ id: 505, title: '정비', code: 'SVC' }),
    ];
  }

  it('(a) code / price.sku / price.barcode 로 ON_SALE 상품을 찾는다', async () => {
    const h = await createHarness();
    seed(h);
    await h.run(
      syncCmd(12, [
        line(12, 1, { productCode: 'ENG-OIL-S' }),
        line(12, 2, { productCode: 'FLT-OIL' }),
        line(12, 3, { productCode: '8801234' }),
      ]),
    );
    assert.deepEqual(
      addedDtos(h).map((d) => d.item.id),
      [501, 502, 503],
    );
    assert.equal(h.lastAck().ok, true);
  });

  it('(b) 상품코드가 안 맞으면 [기본 상품 코드] 상품을 쓴다', async () => {
    const h = await createHarness({ settings: { defaultItemCode: 'SVC' } });
    seed(h);
    await h.run(syncCmd(12, [line(12, 1, { productCode: 'NOPE' })]));
    assert.equal(addedDtos(h)[0]!.item.id, 505);
  });

  it('(c) 기본 상품 코드도 없거나 맞지 않으면 ON_SALE 첫 상품(삭제된 상품은 건너뜀)', async () => {
    const h = await createHarness({ settings: { defaultItemCode: 'ZZZ' } });
    seed(h);
    await h.run(syncCmd(12, [line(12, 1, { productCode: 'NOPE' }), line(12, 2, { productCode: 'OLD' })]));
    assert.deepEqual(
      addedDtos(h).map((d) => d.item.id),
      [501, 501],
      '삭제된 상품(OLD)은 매칭하지 않는다',
    );
  });

  it('matchCatalog 가 꺼져 있으면 상품코드로 찾지 않고 (b)/(c) 밑판을 쓴다(카탈로그는 조회)', async () => {
    const h = await createHarness({ settings: { matchCatalog: false } });
    seed(h);
    await h.run(syncCmd(12, [line(12, 1, { productCode: 'FLT-OIL' })]));
    assert.equal(addedDtos(h)[0]!.item.id, 501);
    assert.equal(h.sdk.callsOf('catalog.getCatalogs').length, 1);
  });

  it('카탈로그에 판매 중인 상품이 없으면 명령이 실패한다(SDK 변경 호출 없음)', async () => {
    const h = await createHarness();
    h.sdk.catalogItems = [catalogItem({ id: 504, title: '삭제됨', state: 'DELETED' })];
    await h.run(syncCmd(12, [line(12, 1)]));
    const ack = h.lastAck();
    assert.equal(ack.ok, false);
    assert.equal(ack.error, NO_CATALOG_MESSAGE);
    assert.equal(addedDtos(h).length, 0);
    assert.match(h.sdk.toasts[0]!.message, /POS에 등록된 상품이 하나 이상 있어야 해요/);
  });

  it('카탈로그가 비어 있어도 같은 방식으로 실패한다', async () => {
    const h = await createHarness();
    h.sdk.catalogItems = [];
    await h.run(syncCmd(12, [line(12, 1)]));
    assert.equal(h.lastAck().ok, false);
    assert.equal(h.lastAck().error, NO_CATALOG_MESSAGE);
  });

  it('카탈로그 조회가 (호출 제한이 아닌) 오류로 실패하면 이 명령은 실패하고, 다음 명령에서 다시 조회한다', async () => {
    const h = await createHarness();
    let fail = true;
    h.sdk.catalogHook = () => {
      if (fail) throw new Error('카탈로그 오류');
    };
    await h.run(syncCmd(12, [line(12, 1)]));
    assert.equal(h.lastAck().ok, false);
    assert.match(h.lastAck().error!, /카탈로그 오류/);
    fail = false;
    await h.run(syncCmd(12, [line(12, 1)]));
    assert.equal(h.lastAck().ok, true);
    assert.equal(h.sdk.callsOf('catalog.getCatalogs').length, 2);
  });

  it('이전에 받은 목록이 있으면 재조회 실패에도 그 목록으로 진행하고 5분 뒤 다시 시도한다', async () => {
    const h = await createHarness();
    seed(h);
    await h.run(syncCmd(12, [line(12, 1, { productCode: 'ENG-OIL-S' })]));
    h.sdk.catalogHook = () => {
      throw new Error('카탈로그 오류');
    };
    h.sdk.emitCatalogEvent();
    await h.clock.advance(5 * 60_000);
    await h.run(syncCmd(12, [line(12, 1, { productCode: 'ENG-OIL-S' }), line(12, 2, { productCode: 'FLT-OIL' })]));
    assert.equal(h.lastAck().ok, true);
    assert.equal(last(addedDtos(h)).item.id, 502);
    assert.equal(h.sdk.callsOf('catalog.getCatalogs').length, 2);
  });

  it('카탈로그는 처음 필요할 때 한 번만 조회한다', async () => {
    const h = await createHarness();
    seed(h);
    assert.equal(h.sdk.callsOf('catalog.getCatalogs').length, 0, '시작할 때는 조회하지 않는다');
    await h.run(syncCmd(12, [line(12, 1, { productCode: 'ENG-OIL-S' })]));
    await h.run(syncCmd(12, [line(12, 1, { productCode: 'ENG-OIL-S' }), line(12, 2, { productCode: 'FLT-OIL' })]));
    assert.equal(h.sdk.callsOf('catalog.getCatalogs').length, 1);
  });

  it('카탈로그 이벤트로 stale 표시되어도 5분 안에는 다시 조회하지 않고, 5분이 지나면 조회한다', async () => {
    const h = await createHarness();
    seed(h);
    await h.run(syncCmd(12, [line(12, 1, { productCode: 'ENG-OIL-S' })]));
    assert.equal(h.sdk.callsOf('catalog.getCatalogs').length, 1);

    h.sdk.emitCatalogEvent();
    await h.clock.advance(60_000);
    await h.run(syncCmd(12, [line(12, 1, { productCode: 'ENG-OIL-S' }), line(12, 2, { productCode: 'FLT-OIL' })]));
    assert.equal(h.sdk.callsOf('catalog.getCatalogs').length, 1, '5분 안에는 재조회 없음');

    await h.clock.advance(5 * 60_000);
    await h.run(
      syncCmd(12, [
        line(12, 1, { productCode: 'ENG-OIL-S' }),
        line(12, 2, { productCode: 'FLT-OIL' }),
        line(12, 3, { productCode: '8801234' }),
      ]),
    );
    assert.equal(h.sdk.callsOf('catalog.getCatalogs').length, 2, 'stale 이고 5분이 지났으니 재조회');

    // stale 이 아니면 시간이 지나도 재조회하지 않는다
    await h.clock.advance(60 * 60_000);
    await h.run(
      syncCmd(12, [
        line(12, 1, { productCode: 'ENG-OIL-S' }),
        line(12, 2, { productCode: 'FLT-OIL' }),
        line(12, 3, { productCode: '8801234' }),
        line(12, 4, { productCode: 'NOPE' }),
      ]),
    );
    assert.equal(h.sdk.callsOf('catalog.getCatalogs').length, 2);
  });

  it('카탈로그 조회가 호출 제한에 걸리면 명령을 15초 뒤 다시 시도한다', async () => {
    const h = await createHarness();
    seed(h);
    let n = 0;
    h.sdk.catalogHook = () => {
      if (n++ === 0) throw new FakeRateLimitError();
    };
    h.transport.sendCommand(syncCmd(12, [line(12, 1, { productCode: 'ENG-OIL-S' })]));
    await settle();
    assert.equal(addedDtos(h).length, 0);
    await h.clock.advance(15_000);
    assert.equal(addedDtos(h)[0]!.item.id, 501);
    assert.equal(h.lastAck().ok, true);
  });
});

describe('addLineItem 실패 재시도: (a) 밑판 실패 -> (b)/(c) 밑판으로 1회', () => {
  function seed(h: Awaited<ReturnType<typeof createHarness>>): void {
    h.sdk.catalogItems = [
      catalogItem({ id: 501, title: 'POS 엔진오일', code: 'ENG-OIL-S' }),
      catalogItem({ id: 505, title: '정비', code: 'SVC' }),
    ];
  }

  it('매칭 상품으로 추가하다 실패하면 기본 상품 코드 상품으로 한 번 다시 시도한다', async () => {
    const h = await createHarness({ settings: { defaultItemCode: 'SVC' } });
    seed(h);
    let n = 0;
    h.sdk.hooks.addLineItem = () => {
      if (n++ === 0) throw new Error('거부됨');
    };
    await h.run(syncCmd(12, [line(12, 1, { productCode: 'ENG-OIL-S' })]));
    assert.deepEqual(
      addedDtos(h).map((d) => d.item.id),
      [501, 505],
    );
    assert.equal(h.lastAck().ok, true);
    assert.equal(h.sdk.callsOf('category.getCategories').length, 0, '카테고리 폴백은 더 이상 없다');
  });

  it('기본 상품 코드가 없으면 첫 판매 상품으로 한 번 다시 시도한다', async () => {
    const h = await createHarness();
    h.sdk.catalogItems = [catalogItem({ id: 600, title: '첫 상품' }), catalogItem({ id: 501, title: '오일', code: 'ENG-OIL-S' })];
    let n = 0;
    h.sdk.hooks.addLineItem = () => {
      if (n++ === 0) throw new Error('거부됨');
    };
    await h.run(syncCmd(12, [line(12, 1, { productCode: 'ENG-OIL-S' })]));
    assert.deepEqual(
      addedDtos(h).map((d) => d.item.id),
      [501, 600],
    );
    assert.equal(h.lastAck().ok, true);
  });

  it('재시도도 실패하면 마지막 오류로 ack ok:false (총 2번)', async () => {
    const h = await createHarness();
    h.sdk.catalogItems = [catalogItem({ id: 600, title: '첫 상품' }), catalogItem({ id: 501, title: '오일', code: 'ENG-OIL-S' })];
    h.sdk.hooks.addLineItem = () => {
      throw new Error('계속 거부');
    };
    await h.run(syncCmd(12, [line(12, 1, { productCode: 'ENG-OIL-S' })]));
    assert.equal(addedDtos(h).length, 2);
    assert.equal(h.lastAck().ok, false);
    assert.match(h.lastAck().error!, /계속 거부/);
  });

  it('처음부터 (b)/(c) 밑판을 썼다면 재시도하지 않는다', async () => {
    const h = await createHarness();
    h.sdk.hooks.addLineItem = () => {
      throw new Error('거부됨');
    };
    await h.run(syncCmd(12, [line(12, 1, { productCode: 'NOPE' })]));
    assert.equal(addedDtos(h).length, 1);
    assert.equal(h.lastAck().ok, false);
  });

  it('호출 제한 오류는 재시도 대상이 아니다(명령 단위 15초 재시도만, 같은 밑판)', async () => {
    const h = await createHarness();
    seed(h);
    let n = 0;
    h.sdk.hooks.addLineItem = () => {
      if (n++ === 0) throw new FakeRateLimitError();
    };
    h.transport.sendCommand(syncCmd(12, [line(12, 1, { productCode: 'ENG-OIL-S' })]));
    await settle();
    assert.equal(addedDtos(h).length, 1, '바로 다른 밑판으로 재시도하지 않는다');
    await h.clock.advance(15_000);
    assert.deepEqual(
      addedDtos(h).map((d) => d.item.id),
      [501, 501],
    );
    assert.equal(h.lastAck().ok, true);
  });
});

describe('memo 형식', () => {
  it('memo 는 #작업ID 라벨, 라벨이 없으면 #작업ID', async () => {
    const h = await createHarness();
    await h.run(syncCmd(12, [line(12, 1)], { label: '' }));
    await h.run(syncCmd(13, [line(13, 1)], { label: '34나5678  김   철수\n' }));
    const memos = addedDtos(h).map((d) => d.memo);
    assert.deepEqual(memos, ['#12', '#13 34나5678 김 철수']);
  });

  it('80자를 넘으면 자른다', async () => {
    const h = await createHarness();
    await h.run(syncCmd(12, [line(12, 1)], { label: '가'.repeat(200) }));
    const memo = addedDtos(h)[0]!.memo;
    assert.equal([...memo].length, 80);
    assert.ok(memo.startsWith('#12 가가'));
  });

  it('makeLineMemo / parseLineMemo 는 서로 짝이다', () => {
    assert.equal(parseLineMemo(makeLineMemo(12, '12가1234 홍길동')), 12);
    assert.equal(parseLineMemo('#7'), 7);
    assert.equal(parseLineMemo('#7 가'), 7);
    assert.equal(parseLineMemo('#7가'), null);
    assert.equal(parseLineMemo('gm-12-1'), null);
    assert.equal(parseLineMemo(undefined), null);
    assert.equal(parseLineMemo(''), null);
  });
});

describe('stripNullI18n', () => {
  it('null 인 titleI18n/descriptionI18n 만 중첩까지 지우고 다른 값(다른 null 포함)은 둔다', () => {
    const src = {
      a: 1,
      titleI18n: null,
      keep: null,
      category: { id: 1, titleI18n: null, descriptionI18n: { ko: '가' } },
      list: [{ descriptionI18n: null, x: 2 }],
    };
    const out = stripNullI18n(src);
    assert.deepEqual(out, {
      a: 1,
      keep: null,
      category: { id: 1, descriptionI18n: { ko: '가' } },
      list: [{ x: 2 }],
    });
    assert.equal('titleI18n' in src, true, '원본은 건드리지 않는다');
  });

  it('addLineItem DTO 에서도 null i18n 이 없다(밑판 상품/카테고리에 들어 있어도)', async () => {
    const h = await createHarness();
    h.sdk.catalogItems = [
      catalogItem({
        id: 501,
        title: 'POS',
        code: 'A',
        category: { id: 3, title: '소모품', ...({ titleI18n: null } as object) },
        ...({ titleI18n: null, descriptionI18n: null } as object),
      }),
    ];
    await h.run(syncCmd(12, [line(12, 1, { productCode: 'A' })]));
    const dto = addedDtos(h)[0]! as unknown as { item: Record<string, unknown> };
    assert.equal('titleI18n' in dto.item, false);
    assert.equal('descriptionI18n' in dto.item, false);
    assert.equal('titleI18n' in (dto.item.category as object), false);
  });

  it('price 가 없고 prices 배열만 있는 상품도 prices[0] 을 밑판 가격으로 쓴다', () => {
    const base = { id: 1, title: 'X', category: { id: 1, title: 'c' }, options: [], prices: [{ id: 9, title: '대', sku: 'S' }] } as unknown as CatalogItemLike;
    const dto = buildLineItemDto(base, line(1, 1, { unitPrice: 500 }), '#1');
    const price = dto.itemPrice as unknown as Record<string, unknown>;
    assert.equal(price.id, 9);
    assert.equal(price.title, '대');
    assert.equal(price.priceValue, 500);
  });
});

describe('keyMap 저장/복원 (gm.keymap)', () => {
  it('POS 가 key 를 바꾸면 storage 에 저장되고, 새로 만든 bridge 가 복원해 같은 라인을 알아본다', async () => {
    const h = await createHarness();
    h.sdk.keyMode = 'rewrite';
    await h.run(syncCmd(12, [line(12, 1), line(12, 2)]));
    const saved = JSON.parse(h.sdk.store.get(KEYMAP_KEY)!) as [string, string][];
    assert.deepEqual(
      saved.map((e) => e[0]),
      ['gm-12-1', 'gm-12-2'],
    );
    const posKeys = h.sdk.logicalKeys();
    assert.deepEqual(saved.map((e) => e[1]), posKeys);

    // 탭 다시 로드: 같은 storage/draft 로 새 bridge
    const h2 = await createHarness({ sdk: h.sdk, start: false });
    h2.sdk.resetCalls();
    await h2.bridge.start();
    h2.transport.goOnline();
    h2.bridge.onDraftUpdate(h2.sdk.snapshot());
    await h2.run(syncCmd(12, [line(12, 1, { quantity: 3 })]));
    assert.deepEqual(
      h2.sdk.callsOf('draftOrder.deleteLineItem').map((c) => c.args),
      [[posKeys[0]], [posKeys[1]]],
      '복원된 키맵으로 우리 라인을 알아보고(수량이 바뀐 것과 빠진 것) POS key 로 삭제',
    );
    assert.equal(h2.sdk.callsOf('draftOrder.updateItemQuantity').length, 0);
    assert.deepEqual(h2.lastAck().draft!.ourKeys, ['gm-12-1'], '요약은 우리 key 로 보고');
  });

  it('장바구니에서 사라진 key 는 정리된다', async () => {
    const h = await createHarness();
    h.sdk.keyMode = 'rewrite';
    await h.run(syncCmd(12, [line(12, 1)]));
    assert.equal((JSON.parse(h.sdk.store.get(KEYMAP_KEY)!) as unknown[]).length, 1);
    h.sdk.lines = []; // 결제 완료 등으로 POS 가 비움
    h.sdk.emitDraftUpdate();
    await settle();
    assert.deepEqual(JSON.parse(h.sdk.store.get(KEYMAP_KEY)!), []);
  });

  it('최대 200개만 보관한다(오래된 것부터 버림)', async () => {
    const h = await createHarness();
    h.sdk.keyMode = 'rewrite';
    // 작업 3개(각 100줄, exclusive:false)로 300개를 기억시킨다. 오래된 것부터 버려 200개만 남는다.
    for (const wo of [11, 12, 13]) {
      const lines = Array.from({ length: 100 }, (_, i) => line(wo, i + 1));
      await h.run(syncCmd(wo, lines, { exclusive: false }));
      assert.equal(h.lastAck().ok, true);
    }
    const saved = JSON.parse(h.sdk.store.get(KEYMAP_KEY)!) as [string, string][];
    assert.equal(saved.length, KEYMAP_MAX);
    assert.equal(saved[saved.length - 1]![0], 'gm-13-100');
  });
});
