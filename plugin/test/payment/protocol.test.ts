import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  coerceServerMessage,
  enqueueOutgoing,
  logicalKeyOf,
  makePosKey,
  parseServerMessage,
  parseSyncCartPayload,
  parseWorkOrderId,
  summarizeDraft,
  summarySignature,
} from '../../src/payment/protocol.ts';
import type { PluginMessage } from '../../src/payment/protocol.ts';
import type { DraftLike } from '../../src/payment/sdk-types.ts';

function draftOf(items: { key: string; title?: string; qty?: number; price?: number }[]): DraftLike {
  const lineItems = items.map((i) => ({
    key: i.key,
    item: { id: 0, title: i.title ?? i.key, category: { id: 0, title: 'c' } },
    itemPrice: { priceValue: i.price ?? 1000 },
    quantity: i.qty ?? 1,
  }));
  return {
    lineItems,
    price: { orderPriceValue: lineItems.reduce((s, l) => s + l.itemPrice.priceValue * l.quantity, 0) },
  };
}

describe('parseWorkOrderId', () => {
  it('gm-{wo}-{line} 에서 작업 ID 를 읽는다', () => {
    assert.equal(parseWorkOrderId('gm-12-34'), 12);
    assert.equal(parseWorkOrderId('gm-7-1'), 7);
    assert.equal(parseWorkOrderId('gm-5'), 5);
  });
  it('우리 키가 아니면 null', () => {
    assert.equal(parseWorkOrderId('abc'), null);
    assert.equal(parseWorkOrderId('gm-x-1'), null);
    assert.equal(parseWorkOrderId('xgm-1-2'), null);
  });
});

describe('summarizeDraft', () => {
  it('집계 / ourKeys / workOrderIds(중복 제거·오름차순)', () => {
    const d = draftOf([
      { key: 'gm-12-1', qty: 2, price: 5000 },
      { key: 'manual-1', qty: 3, price: 1000 },
      { key: 'gm-3-9' },
      { key: 'gm-12-2' },
    ]);
    const s = summarizeDraft(d, new Map(), '2026-11-03T00:00:00.000Z');
    assert.equal(s.lineCount, 4);
    assert.equal(s.totalQuantity, 7);
    assert.equal(s.orderPriceValue, 2 * 5000 + 3 * 1000 + 1000 + 1000);
    assert.deepEqual(s.ourKeys, ['gm-12-1', 'gm-3-9', 'gm-12-2']);
    assert.deepEqual(s.workOrderIds, [3, 12]);
    assert.equal(s.updatedAt, '2026-11-03T00:00:00.000Z');
    assert.deepEqual(s.lines[0], { key: 'gm-12-1', title: 'gm-12-1', quantity: 2, priceValue: 5000 });
  });

  it('POS 가 바꾼 key 는 역매핑해 우리 key 로 보고한다', () => {
    const d = draftOf([{ key: 'pos-abc' }, { key: 'pos-zzz' }]);
    const s = summarizeDraft(d, new Map([['pos-abc', 'gm-5-1']]), 't');
    assert.deepEqual(s.ourKeys, ['gm-5-1']);
    assert.deepEqual(s.workOrderIds, [5]);
    assert.equal(s.lines[0]!.key, 'gm-5-1');
    assert.equal(s.lines[1]!.key, 'pos-zzz');
  });

  it('lines 는 최대 50개, 집계는 전체 기준', () => {
    const d = draftOf(Array.from({ length: 60 }, (_, i) => ({ key: `gm-1-${i}` })));
    const s = summarizeDraft(d, new Map(), 't');
    assert.equal(s.lines.length, 50);
    assert.equal(s.lineCount, 60);
    assert.equal(s.ourKeys.length, 60);
  });

  it('summarySignature 는 updatedAt 에 영향받지 않고 내용이 바뀌면 달라진다', () => {
    const d = draftOf([{ key: 'gm-1-1' }]);
    const a = summarizeDraft(d, new Map(), 'time-1');
    const b = summarizeDraft(d, new Map(), 'time-2');
    assert.equal(summarySignature(a), summarySignature(b));
    const c = summarizeDraft(draftOf([{ key: 'gm-1-1', qty: 2 }]), new Map(), 'time-1');
    assert.notEqual(summarySignature(a), summarySignature(c));
  });
});

describe('서버 메시지 파싱', () => {
  it('welcome / ping / error / command', () => {
    assert.deepEqual(parseServerMessage('{"type":"welcome","serverVersion":"1.0.0","serverTime":"t"}'), {
      type: 'welcome',
      serverVersion: '1.0.0',
      serverTime: 't',
    });
    assert.deepEqual(parseServerMessage('{"type":"ping","t":123}'), { type: 'ping', t: 123 });
    assert.deepEqual(parseServerMessage('{"type":"error","code":"UNAUTHORIZED","message":"x"}'), {
      type: 'error',
      code: 'UNAUTHORIZED',
      message: 'x',
    });
    const c = parseServerMessage(
      '{"type":"command","command":{"id":"cmd-1","seq":1,"kind":"CLEAR_CART","createdAt":"t","payload":{"scope":"ours"}}}',
    );
    assert.equal(c?.type, 'command');
  });

  it('깨졌거나 모르는 메시지는 null', () => {
    assert.equal(parseServerMessage('not json'), null);
    assert.equal(parseServerMessage('[]'), null);
    assert.equal(parseServerMessage('{"type":"mystery"}'), null);
    assert.equal(parseServerMessage('{"type":"command","command":{"kind":"SYNC_CART"}}'), null);
    assert.equal(coerceServerMessage(null), null);
  });
});

describe('parseSyncCartPayload', () => {
  const base = {
    workOrderId: 12,
    label: 'L',
    startPayment: true,
    exclusive: true,
    lines: [
      {
        key: 'gm-12-1',
        productCode: 'ENG-OIL-S',
        title: '엔진오일',
        category: '소모품',
        unitPrice: 69000,
        quantity: 2,
        taxFree: false,
      },
    ],
  };

  it('정상 페이로드', () => {
    const r = parseSyncCartPayload(base);
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.value.workOrderId, 12);
      assert.equal(r.value.lines[0]!.unitPrice, 69000);
      assert.equal(r.value.startPayment, true);
    }
  });

  it('잘못된 값은 오류', () => {
    const bad = (mutate: (p: Record<string, unknown>) => void): boolean => {
      const p = structuredClone(base) as Record<string, unknown>;
      mutate(p);
      return parseSyncCartPayload(p).ok;
    };
    assert.equal(bad((p) => (p.workOrderId = 'x')), false);
    assert.equal(bad((p) => (p.lines = 'x')), false);
    assert.equal(bad((p) => ((p.lines as { quantity: number }[])[0]!.quantity = 0)), false);
    assert.equal(bad((p) => ((p.lines as { quantity: number }[])[0]!.quantity = 1.5)), false);
    assert.equal(bad((p) => ((p.lines as { unitPrice: number }[])[0]!.unitPrice = -1)), false);
    assert.equal(bad((p) => ((p.lines as { key: string }[])[0]!.key = 'abc')), false);
    assert.equal(bad((p) => ((p.lines as { key: string }[])[0]!.key = 'gm-12-1_ab12cd34')), false, '_ 는 POS key 구분자라 쓸 수 없다');
    assert.equal(bad((p) => ((p.lines as { key: string }[])[0]!.key = 'gm-12-a_b')), false);
    assert.equal(bad((p) => ((p.lines as unknown[]).push((p.lines as unknown[])[0]))), false); // 중복 key
    assert.equal(parseSyncCartPayload(null).ok, false);
  });

  it('productCode 가 null/없음이어도 문자열로 정리한다(sku null 금지)', () => {
    const p = structuredClone(base) as { lines: Record<string, unknown>[] };
    p.lines[0]!.productCode = null;
    const r = parseSyncCartPayload(p);
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.value.lines[0]!.productCode, '');
  });
});

describe('enqueueOutgoing', () => {
  const ack = (i: number): PluginMessage => ({ type: 'ack', commandId: `c${i}`, ok: true, draft: null });
  const log = (i: number): PluginMessage => ({ type: 'log', level: 'warn', message: `m${i}` });
  const draft = (i: number): PluginMessage => ({
    type: 'draft',
    draft: { lineCount: i, totalQuantity: 0, orderPriceValue: 0, ourKeys: [], workOrderIds: [], lines: [], updatedAt: '' },
  });

  it('max 를 넘으면 ack/payment.* 가 아닌 오래된 것부터 버린다', () => {
    const q: PluginMessage[] = [];
    for (let i = 0; i < 3; i++) enqueueOutgoing(q, ack(i), 5);
    for (let i = 0; i < 4; i++) enqueueOutgoing(q, log(i), 5);
    assert.equal(q.length, 5);
    assert.deepEqual(
      q.map((m) => m.type),
      ['ack', 'ack', 'ack', 'log', 'log'],
    );
    assert.equal((q[3] as { message: string }).message, 'm2'); // m0, m1 이 버려짐
  });

  it('전부 우선순위 메시지면 가장 오래된 것부터 버린다', () => {
    const q: PluginMessage[] = [];
    for (let i = 0; i < 7; i++) enqueueOutgoing(q, ack(i), 5);
    assert.deepEqual(
      q.map((m) => (m as { commandId: string }).commandId),
      ['c2', 'c3', 'c4', 'c5', 'c6'],
    );
  });

  it('draft 는 마지막 것만 남긴다', () => {
    const q: PluginMessage[] = [];
    enqueueOutgoing(q, draft(1), 10);
    enqueueOutgoing(q, ack(1), 10);
    enqueueOutgoing(q, draft(2), 10);
    assert.deepEqual(
      q.map((m) => m.type),
      ['ack', 'draft'],
    );
    assert.equal((q[1] as { draft: { lineCount: number } }).draft.lineCount, 2);
  });
});

describe('POS key 와 논리 key', () => {
  it('makePosKey / logicalKeyOf 는 서로 짝이다', () => {
    const pos = makePosKey('gm-4-10', 'aB3dE5gH');
    assert.equal(pos, 'gm-4-10_aB3dE5gH');
    assert.equal(logicalKeyOf(pos), 'gm-4-10');
  });

  it('꼬리가 없는 옛 key 는 그대로, 우리 key 가 아니면 null', () => {
    assert.equal(logicalKeyOf('gm-4-10'), 'gm-4-10');
    assert.equal(logicalKeyOf('manual-1'), null);
    assert.equal(logicalKeyOf('pos-1'), null);
    assert.equal(logicalKeyOf('manual_abcdefgh'), null);
  });

  it('꼬리가 영숫자 8자가 아니면 떼지 않는다', () => {
    assert.equal(logicalKeyOf('gm-4-10_short'), 'gm-4-10_short');
    assert.equal(logicalKeyOf('gm-4-10_toolong123'), 'gm-4-10_toolong123');
  });

  it('summarizeDraft 는 논리 key 로 보고한다(작업 ID 도 읽는다)', () => {
    const s = summarizeDraft(
      draftOf([{ key: 'gm-4-10_n0000001' }, { key: 'gm-4-11' }, { key: 'manual-1' }]),
      new Map(),
      'T',
    );
    assert.deepEqual(s.ourKeys, ['gm-4-10', 'gm-4-11']);
    assert.deepEqual(s.lines.map((l) => l.key), ['gm-4-10', 'gm-4-11', 'manual-1']);
    assert.deepEqual(s.workOrderIds, [4]);
  });
});
