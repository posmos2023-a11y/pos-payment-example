import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { settle } from './fake-clock.ts';
import { PAYMENT_LOOKUP_ATTEMPTS, PAYMENT_LOOKUP_RETRY_MS, RATE_LIMIT_WAIT_MS } from '../../src/payment/bridge.ts';
import { clearCmd, createHarness, line, syncCmd } from './harness.ts';

/** 작업 12 를 POS 에 담아 둔 상태에서 시작 */
async function withWorkOrder(workOrderId = 12) {
  const h = await createHarness();
  await h.run(syncCmd(workOrderId, [line(workOrderId, 1, { unitPrice: 50000, quantity: 1 }), line(workOrderId, 2)]));
  h.transport.sent.length = 0;
  return h;
}

/** 결제가 끝나면 POS 가 임시 주문을 비운다 */
function posClearsDraft(h: Awaited<ReturnType<typeof withWorkOrder>>): void {
  h.sdk.lines = [];
  h.sdk.emitDraftUpdate();
}

describe('payment.on(paid)', () => {
  it('getOrder 로 확인해 fullyPaid / paidValue / unpaidValue 와 작업 ID 를 보낸다', async () => {
    const h = await withWorkOrder();
    posClearsDraft(h); // 이벤트 시점에는 이미 draft 가 비어 있을 수 있다
    h.sdk.setOrder('ord-1', 0, 60000);
    h.sdk.emitPaid('pay-1', 'ord-1');
    await settle();
    assert.deepEqual(h.sdk.callsOf('order.getOrder').map((c) => c.args), [['ord-1']]);
    const paid = h.transport.of('payment.paid');
    assert.equal(paid.length, 1);
    assert.deepEqual(paid[0], {
      type: 'payment.paid',
      paymentId: 'pay-1',
      orderId: 'ord-1',
      workOrderIds: [12],
      fullyPaid: true,
      paidValue: 60000,
      unpaidValue: 0,
    });
  });

  it('미납금이 남아 있으면 fullyPaid:false (부분 결제), 작업 ID 기억은 유지된다', async () => {
    const h = await withWorkOrder();
    h.sdk.setOrder('ord-1', 20000, 40000);
    await h.bridge.onPaid('pay-1', 'ord-1');
    let paid = h.transport.of('payment.paid');
    assert.equal(paid[0]!.fullyPaid, false);
    assert.equal(paid[0]!.paidValue, 40000);
    assert.equal(paid[0]!.unpaidValue, 20000);
    assert.deepEqual(paid[0]!.workOrderIds, [12]);

    // 남은 금액 결제
    h.sdk.setOrder('ord-1', 0, 60000);
    await h.bridge.onPaid('pay-2', 'ord-1');
    paid = h.transport.of('payment.paid');
    assert.equal(paid[1]!.fullyPaid, true);
    assert.deepEqual(paid[1]!.workOrderIds, [12], '부분 결제 뒤에도 같은 작업으로 보고');
  });

  it('전액 결제된 뒤의 (전산과 무관한) 다음 결제에는 작업 ID 를 붙이지 않는다', async () => {
    const h = await withWorkOrder();
    h.sdk.setOrder('ord-1', 0, 60000);
    await h.bridge.onPaid('pay-1', 'ord-1');
    h.sdk.setOrder('ord-2', 0, 3000);
    await h.bridge.onPaid('pay-2', 'ord-2');
    const paid = h.transport.of('payment.paid');
    assert.deepEqual(paid[0]!.workOrderIds, [12]);
    assert.deepEqual(paid[1]!.workOrderIds, []);
  });

  it('주문에 항목 목록이 있으면 장바구니 기억이 아니라 주문 항목 메모(#작업ID)로 작업을 정한다', async () => {
    const h = await withWorkOrder(); // 작업 12 가 장바구니에 담긴 채 결제를 기다리는 중
    // 전산과 무관한 다른 주문의 결제: 담겨 있는 작업 12 에 붙이지 않는다
    h.sdk.orders.set('ord-other', {
      paymentPrice: { paymentUnpaidValue: 0, paymentPaidValue: 3000 },
      lineItems: [{ memo: '' }, {}],
    });
    await h.bridge.onPaid('pay-other', 'ord-other');
    // 장바구니 기억(12)과 다른 작업(7)의 주문: 주문 내용을 따른다
    h.sdk.orders.set('ord-7', {
      paymentPrice: { paymentUnpaidValue: 0, paymentPaidValue: 20000 },
      lineItems: [{ memo: '#7 7가1234 홍길동' }],
    });
    await h.bridge.onPaid('pay-7', 'ord-7');
    // 위 두 결제는 기억(12)을 지우지 않는다: 항목 목록이 없는 응답이 와도 작업 12 의 결제는 12 로 보고된다
    h.sdk.setOrder('ord-12', 0, 60000);
    await h.bridge.onPaid('pay-12', 'ord-12');
    const paid = h.transport.of('payment.paid');
    assert.deepEqual(paid.map((p) => p.workOrderIds), [[], [7], [12]]);
  });

  it('탭이 다시 로드돼 장바구니 기억이 없어도 주문 항목 메모로 작업을 찾는다', async () => {
    const h = await createHarness(); // 아무것도 담지 않았다(기억 없음)
    h.sdk.orders.set('ord-1', {
      paymentPrice: { paymentUnpaidValue: 0, paymentPaidValue: 60000 },
      lineItems: [{ memo: '#12 12가1234 홍길동' }, { memo: '#12 12가1234 홍길동' }, { memo: '#3 3가1234' }, { memo: '포장' }],
    });
    await h.bridge.onPaid('pay-1', 'ord-1');
    assert.deepEqual(h.transport.of('payment.paid')[0]!.workOrderIds, [3, 12]);
  });

  it('getOrder 가 계속 실패하면 3회 시도 뒤 전액 결제로 간주하지 않는다(fullyPaid:false, paidValue:0, unpaidValue:-1)', async () => {
    const h = await withWorkOrder();
    // ord-x 는 등록하지 않음 -> getOrder 가 계속 던진다
    h.sdk.emitPaid('pay-1', 'ord-x');
    await h.clock.advance(PAYMENT_LOOKUP_RETRY_MS * PAYMENT_LOOKUP_ATTEMPTS);
    assert.equal(h.sdk.callsOf('order.getOrder').length, PAYMENT_LOOKUP_ATTEMPTS);
    const paid = h.transport.of('payment.paid');
    assert.equal(paid.length, 1);
    assert.equal(paid[0]!.fullyPaid, false);
    assert.equal(paid[0]!.paidValue, 0);
    assert.equal(paid[0]!.unpaidValue, -1);
    assert.deepEqual(paid[0]!.workOrderIds, [12], '실패해도 작업 ID 는 보고');
    assert.equal(h.transport.of('log').length, 1, '서버 warn 로그는 최종 실패 때 한 번만');
    assert.equal(h.transport.of('log')[0]!.level, 'warn');
  });

  it('getOrder 가 호출 제한에 계속 걸려도 3회 시도 뒤 같은 방식으로 보고한다', async () => {
    const h = await withWorkOrder();
    h.sdk.setOrder('ord-1', 0, 1);
    h.sdk.orderHook = () => {
      throw new Error(`해당 기능은 60초당 100회만 호출할 수 있습니다`);
    };
    h.sdk.emitPaid('pay-1', 'ord-1');
    await h.clock.advance(RATE_LIMIT_WAIT_MS * PAYMENT_LOOKUP_ATTEMPTS);
    const paid = h.transport.of('payment.paid')[0]!;
    assert.equal(paid.fullyPaid, false);
    assert.equal(paid.unpaidValue, -1);
    assert.equal(h.sdk.callsOf('order.getOrder').length, PAYMENT_LOOKUP_ATTEMPTS);
  });

  it('첫 시도가 실패하고 두 번째가 성공하면 정상 값으로 1건만 보고한다', async () => {
    const h = await withWorkOrder();
    h.sdk.setOrder('ord-1', 0, 60000);
    h.sdk.orderFailures = [new Error('일시 오류')];
    h.sdk.emitPaid('pay-1', 'ord-1');
    await settle();
    assert.equal(h.transport.of('payment.paid').length, 0, '대기 중에는 아직 보고하지 않는다');
    await h.clock.advance(PAYMENT_LOOKUP_RETRY_MS);
    assert.equal(h.sdk.callsOf('order.getOrder').length, 2);
    const paid = h.transport.of('payment.paid');
    assert.equal(paid.length, 1);
    assert.equal(paid[0]!.fullyPaid, true);
    assert.equal(paid[0]!.paidValue, 60000);
    assert.equal(paid[0]!.unpaidValue, 0);
    assert.deepEqual(paid[0]!.workOrderIds, [12]);
    assert.equal(h.transport.of('log').length, 0, '중간 실패는 서버로 보고하지 않는다');
  });

  it('호출 제한 오류는 15초, 그 외 오류는 5초 기다린 뒤 다시 부른다', async () => {
    const h = await withWorkOrder();
    h.sdk.setOrder('ord-1', 0, 1000);
    h.sdk.orderFailures = [new Error('해당 기능은 60초당 100회만 호출할 수 있습니다')];
    h.sdk.emitPaid('pay-1', 'ord-1');
    await settle();
    assert.equal(h.sdk.callsOf('order.getOrder').length, 1);
    await h.clock.advance(RATE_LIMIT_WAIT_MS - 1);
    assert.equal(h.sdk.callsOf('order.getOrder').length, 1, '15초가 되기 전에는 부르지 않는다');
    await h.clock.advance(1);
    assert.equal(h.sdk.callsOf('order.getOrder').length, 2);
    assert.equal(h.transport.of('payment.paid').length, 1);

    h.sdk.setOrder('ord-2', 0, 1000);
    h.sdk.orderFailures = [new Error('요청이 지연되고 있어요')];
    h.sdk.emitPaid('pay-2', 'ord-2');
    await settle();
    assert.equal(h.sdk.callsOf('order.getOrder').length, 3);
    await h.clock.advance(PAYMENT_LOOKUP_RETRY_MS - 1);
    assert.equal(h.sdk.callsOf('order.getOrder').length, 3, '5초가 되기 전에는 부르지 않는다');
    await h.clock.advance(1);
    assert.equal(h.sdk.callsOf('order.getOrder').length, 4);
    assert.equal(h.transport.of('payment.paid').length, 2);
  });

  it('금액 정보가 숫자가 아니면 실패로 보고 다시 시도한다', async () => {
    const h = await withWorkOrder();
    h.sdk.orders.set('ord-1', { paymentPrice: { paymentUnpaidValue: undefined, paymentPaidValue: undefined } } as never);
    h.sdk.emitPaid('pay-1', 'ord-1');
    await h.clock.advance(PAYMENT_LOOKUP_RETRY_MS * PAYMENT_LOOKUP_ATTEMPTS);
    assert.equal(h.sdk.callsOf('order.getOrder').length, PAYMENT_LOOKUP_ATTEMPTS);
    assert.equal(h.transport.of('payment.paid')[0]!.unpaidValue, -1);
  });

  it('재시도 대기 중 stop() 하면 더 부르지 않고 끝난다(결제는 보존되어 잃지 않는다)', async () => {
    const h = await withWorkOrder();
    h.sdk.setOrder('ord-1', 0, 1000);
    h.sdk.orderFailures = [new Error('일시 오류')];
    const done = h.bridge.onPaid('pay-1', 'ord-1');
    await settle();
    assert.equal(h.sdk.callsOf('order.getOrder').length, 1);
    await h.bridge.stop();
    await done; // 행 걸림 없이 끝나야 한다
    await h.clock.advance(60_000);
    assert.equal(h.sdk.callsOf('order.getOrder').length, 1, 'stop 뒤에는 더 부르지 않는다');
    const saved = JSON.parse(String(await h.sdk.storage.get('gm.payments'))) as { msg: { type: string; unpaidValue: number } }[];
    assert.equal(saved.length, 1);
    assert.equal(saved[0]!.msg.type, 'payment.paid');
    assert.equal(saved[0]!.msg.unpaidValue, -1);
  });

  it('같은 paymentId 의 중복 이벤트는 getOrder 를 다시 부르지 않고 한 번만 보고한다', async () => {
    const h = await withWorkOrder();
    h.sdk.setOrder('ord-1', 0, 60000);
    h.sdk.emitPaid('pay-1', 'ord-1');
    h.sdk.emitPaid('pay-1', 'ord-1');
    await settle();
    await h.bridge.onPaid('pay-1', 'ord-1');
    await h.clock.advance(60_000);
    assert.equal(h.sdk.callsOf('order.getOrder').length, 1);
    assert.equal(h.transport.of('payment.paid').length, 1);
  });

  it('우리 라인이 없던 POS 의 결제는 workOrderIds 가 빈 배열', async () => {
    const h = await createHarness();
    h.sdk.setOrder('ord-1', 0, 5000);
    await h.bridge.onPaid('pay-1', 'ord-1');
    const paid = h.transport.of('payment.paid')[0]!;
    assert.deepEqual(paid.workOrderIds, []);
    assert.equal(paid.fullyPaid, true);
  });
});

// 결제-작업 연결 기억 attrib = { ids, goneAt }
describe('결제-작업 연결 기억(attrib)', () => {
  /** 결제를 보고하고 그 payment.paid 의 workOrderIds 를 돌려준다 */
  async function paidIds(h: Awaited<ReturnType<typeof withWorkOrder>>, tag: string, unpaid = 0): Promise<number[]> {
    h.sdk.setOrder(`ord-${tag}`, unpaid, 1000);
    await h.bridge.onPaid(`pay-${tag}`, `ord-${tag}`);
    const all = h.transport.of('payment.paid');
    return all[all.length - 1]!.workOrderIds;
  }

  it('draft 에 gm- 라인이 있으면 그 작업들(오름차순)로 교체한다', async () => {
    const h = await createHarness();
    await h.run(syncCmd(9, [line(9, 1)], { exclusive: false }));
    await h.run(syncCmd(3, [line(3, 1)], { exclusive: false }));
    assert.deepEqual(await paidIds(h, '1'), [3, 9]);
  });

  it('gm- 없이 POS 에서 직접 담은 라인만 있으면 []: 전산과 무관한 결제', async () => {
    const h = await withWorkOrder();
    h.sdk.lines = [];
    h.sdk.addManualLine('manual-1', '수동', 1, 1000, true); // gm- 라인이 사라지고 수동 라인만 남음
    assert.deepEqual(await paidIds(h, '1'), []);
  });

  it('수동 라인이 함께 있어도 gm- 라인이 있으면 그 작업으로 연결한다', async () => {
    const h = await withWorkOrder();
    h.sdk.addManualLine('manual-1', '수동', 1, 1000, true);
    assert.deepEqual(await paidIds(h, '1'), [12]);
  });

  it('빈 draft 는 작업 ID 를 유지하고, 비워진 시각(goneAt)부터 5분 안의 결제만 연결한다 (정확히 5분은 포함)', async () => {
    const h = await withWorkOrder();
    posClearsDraft(h);
    await h.clock.advance(5 * 60_000);
    assert.deepEqual(await paidIds(h, '1'), [12]);

    const h2 = await withWorkOrder();
    posClearsDraft(h2);
    await h2.clock.advance(5 * 60_000 + 1);
    assert.deepEqual(await paidIds(h2, '1'), []);
  });

  it('빈 draft 업데이트가 여러 번 와도 goneAt 은 처음 비워진 시각 그대로다', async () => {
    const h = await withWorkOrder();
    posClearsDraft(h);
    await h.clock.advance(4 * 60_000);
    h.sdk.emitDraftUpdate(); // 여전히 빈 draft
    await h.clock.advance(2 * 60_000); // 처음 비워진 지 6분
    assert.deepEqual(await paidIds(h, '1'), []);
  });

  it('draft 에 gm- 라인이 남아 있는 동안은 시간 제한이 없다(결제 화면을 오래 열어 둔 경우)', async () => {
    const h = await withWorkOrder();
    await h.clock.advance(3 * 60 * 60_000);
    assert.deepEqual(await paidIds(h, '1'), [12]);
  });

  it('paid 이벤트가 draft 비움 업데이트보다 먼저 와도 연결된다', async () => {
    const h = await withWorkOrder();
    h.sdk.setOrder('ord-1', 0, 1000);
    await h.bridge.onPaid('pay-1', 'ord-1');
    posClearsDraft(h);
    assert.deepEqual(h.transport.of('payment.paid')[0]!.workOrderIds, [12]);
  });

  it('비워진 뒤 수동 라인이 담기면 기억을 버린다(그 뒤 5분 안이어도 전산과 무관)', async () => {
    const h = await withWorkOrder();
    posClearsDraft(h);
    await h.clock.advance(60_000);
    h.sdk.addManualLine('manual-1', '수동', 1, 1000, true);
    assert.deepEqual(await paidIds(h, '1'), []);
  });

  it('다시 우리 라인이 담기면 goneAt 이 지워지고 새 작업으로 교체된다', async () => {
    const h = await withWorkOrder(12);
    posClearsDraft(h);
    await h.clock.advance(10 * 60_000);
    await h.run(syncCmd(13, [line(13, 1)]));
    assert.deepEqual(await paidIds(h, '1'), [13]);
  });

  it('전액 결제가 확인되면 비운다: 같은 작업이 다음 결제에 다시 붙지 않는다', async () => {
    const h = await withWorkOrder();
    assert.deepEqual(await paidIds(h, '1', 0), [12]);
    assert.deepEqual(await paidIds(h, '2', 0), []);
  });

  it('부분 결제(미납금 있음)는 유지한다', async () => {
    const h = await withWorkOrder();
    assert.deepEqual(await paidIds(h, '1', 500), [12]);
    assert.deepEqual(await paidIds(h, '2', 0), [12], '남은 금액 결제도 같은 작업');
    assert.deepEqual(await paidIds(h, '3', 0), [], '전액 결제 뒤에는 비움');
  });

  it('getOrder 가 실패하면 비운다', async () => {
    const h = await withWorkOrder();
    h.sdk.emitPaid('pay-x', 'ord-unknown'); // 등록되지 않은 주문 -> getOrder 오류(3회 시도 뒤 실패 보고)
    await h.clock.advance(PAYMENT_LOOKUP_RETRY_MS * PAYMENT_LOOKUP_ATTEMPTS);
    const failed = h.transport.of('payment.paid')[0]!;
    assert.equal(failed.fullyPaid, false);
    assert.deepEqual(failed.workOrderIds, [12], '실패한 결제 자체는 작업을 보고');
    assert.deepEqual(await paidIds(h, '2'), [], '다음 결제에는 붙지 않는다');
  });

  it('getOrder 를 기다리는 동안 새 작업이 담겼다면 그 기억은 지우지 않는다', async () => {
    const h = await withWorkOrder(12);
    h.sdk.setOrder('ord-1', 0, 1000);
    h.sdk.orderHook = async () => {
      await h.run(syncCmd(13, [line(13, 1)]));
    };
    await h.bridge.onPaid('pay-1', 'ord-1');
    h.sdk.orderHook = undefined;
    assert.deepEqual(h.transport.of('payment.paid')[0]!.workOrderIds, [12]);
    assert.deepEqual(await paidIds(h, '2'), [13]);
  });
});

// e2e(시나리오 k)에서 발견: POS 가 플러그인 자신의 변경에는 draft update 이벤트를 보내지 않으면
// 작업 ID 기억이 비어 있어 결제가 어느 작업인지 알 수 없게 된다. 명령 처리 결과(SDK 변경 메서드가 돌려준 draft)로도 기억한다.
describe('작업 ID 기억은 명령 처리 결과로도 갱신된다', () => {
  it('POS 가 우리 변경에 update 이벤트를 보내지 않아도 결제가 그 작업으로 연결된다', async () => {
    const h = await createHarness();
    h.sdk.emitUpdates = false;
    await h.run(syncCmd(12, [line(12, 1, { unitPrice: 50000 }), line(12, 2)]));
    h.transport.sent.length = 0;
    posClearsDraft(h);
    h.sdk.setOrder('ord-1', 0, 60000);
    await h.bridge.onPaid('pay-1', 'ord-1');
    const paid = h.transport.of('payment.paid')[0]!;
    assert.deepEqual(paid.workOrderIds, [12]);
    assert.equal(paid.fullyPaid, true);
  });

  it('POS에서 빼기(exclusive=false, lines=[]) 뒤의 (전산과 무관한) 결제는 그 작업으로 연결되지 않는다', async () => {
    const h = await withWorkOrder(12);
    await h.run(syncCmd(12, [], { exclusive: false }));
    h.sdk.addManualLine('manual-1', '수동', 1, 1000, true);
    h.sdk.setOrder('ord-1', 0, 1000);
    await h.bridge.onPaid('pay-1', 'ord-1');
    assert.deepEqual(h.transport.of('payment.paid')[0]!.workOrderIds, []);
  });

  it('다른 작업의 라인이 POS 에 남아 있으면 빼기 뒤에도 그 작업 ID 만 기억한다', async () => {
    const h = await createHarness();
    await h.run(syncCmd(9, [line(9, 1)], { exclusive: false }));
    await h.run(syncCmd(3, [line(3, 1)], { exclusive: false }));
    await h.run(syncCmd(9, [], { exclusive: false }));
    h.sdk.setOrder('ord-1', 0, 1000);
    await h.bridge.onPaid('pay-1', 'ord-1');
    assert.deepEqual(h.transport.of('payment.paid')[0]!.workOrderIds, [3]);
  });

  it('CLEAR_CART 로 비운 뒤의 결제도 작업으로 연결되지 않는다', async () => {
    const h = await withWorkOrder(12);
    await h.run(clearCmd());
    h.sdk.addManualLine('manual-1', '수동', 1, 1000, true);
    h.sdk.setOrder('ord-1', 0, 1000);
    await h.bridge.onPaid('pay-1', 'ord-1');
    assert.deepEqual(h.transport.of('payment.paid')[0]!.workOrderIds, []);
  });

  it('건너뛴(superseded) 명령은 작업 ID 기억을 건드리지 않는다', async () => {
    const h = await withWorkOrder(12);
    h.transport.sendCommand(syncCmd(12, [line(12, 1)], { exclusive: false }));
    h.transport.sendCommand(syncCmd(12, [line(12, 1), line(12, 2)], { exclusive: false }));
    await settle();
    h.sdk.setOrder('ord-1', 0, 1000);
    await h.bridge.onPaid('pay-1', 'ord-1');
    assert.deepEqual(h.transport.of('payment.paid')[0]!.workOrderIds, [12]);
  });
});

describe('payment.on(cancel)', () => {
  it('payment.cancelled 를 보낸다', async () => {
    const h = await createHarness();
    h.sdk.emitCancel('pay-1', 'ord-1');
    assert.deepEqual(h.transport.of('payment.cancelled'), [
      { type: 'payment.cancelled', paymentId: 'pay-1', orderId: 'ord-1' },
    ]);
  });
});
