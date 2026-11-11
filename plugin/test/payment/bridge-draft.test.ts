import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { settle } from './fake-clock.ts';
import { createHarness, line, syncCmd } from './harness.ts';

describe('draft update 이벤트: 변경 감지 + 2초 스로틀', () => {
  it('첫 변경은 바로 보내고, 2초 안의 변경은 모아서 2초 시점에 마지막 상태만 보낸다', async () => {
    const h = await createHarness();
    h.sdk.addManualLine('m1', '수동1', 1, 1000, true);
    await settle();
    assert.equal(h.transport.of('draft').length, 1, '첫 변경은 즉시');
    assert.equal(h.transport.of('draft')[0]!.draft.lineCount, 1);

    await h.clock.advance(500);
    h.sdk.addManualLine('m2', '수동2', 1, 1000, true);
    await h.clock.advance(500);
    h.sdk.addManualLine('m3', '수동3', 1, 1000, true);
    await settle();
    assert.equal(h.transport.of('draft').length, 1, '2초 안에는 보내지 않는다');

    await h.clock.advance(999); // 첫 전송으로부터 1999ms
    assert.equal(h.transport.of('draft').length, 1);
    await h.clock.advance(1); // 2000ms
    const drafts = h.transport.of('draft');
    assert.equal(drafts.length, 2);
    assert.equal(drafts[1]!.draft.lineCount, 3, '그 사이 변경은 합쳐져 마지막 상태');
    assert.equal(h.clock.pendingTimers, 0);
  });

  it('내용이 바뀌지 않았으면 보내지 않는다', async () => {
    const h = await createHarness();
    h.sdk.addManualLine('m1', '수동1', 1, 1000, true);
    await settle();
    assert.equal(h.transport.of('draft').length, 1);
    await h.clock.advance(5000);
    h.sdk.emitDraftUpdate(); // 같은 내용
    h.sdk.emitDraftUpdate();
    await h.clock.advance(5000);
    assert.equal(h.transport.of('draft').length, 1);
  });

  it('스로틀 대기 중에 원래 상태로 돌아오면 보내지 않는다', async () => {
    const h = await createHarness();
    h.sdk.addManualLine('m1', '수동1', 1, 1000, true);
    await settle();
    await h.clock.advance(500);
    h.sdk.addManualLine('m2', '수동2', 1, 1000, true);
    h.sdk.lines.pop();
    h.sdk.emitDraftUpdate();
    await h.clock.advance(5000);
    assert.equal(h.transport.of('draft').length, 1);
  });

  it('DraftSummary 내용: ourKeys / workOrderIds / lines / updatedAt(플러그인 시각)', async () => {
    const h = await createHarness();
    await h.run(syncCmd(12, [line(12, 1, { quantity: 2, unitPrice: 5000 })]));
    await h.clock.advance(3000);
    h.sdk.addManualLine('m1', '직접 담은', 3, 700, true);
    await settle();
    const d = h.transport.of('draft')[0]!.draft;
    assert.deepEqual(d.ourKeys, ['gm-12-1']);
    assert.deepEqual(d.workOrderIds, [12]);
    assert.equal(d.lineCount, 2);
    assert.equal(d.totalQuantity, 5);
    assert.equal(d.orderPriceValue, 2 * 5000 + 3 * 700);
    assert.deepEqual(d.lines.map((l) => [l.key, l.title, l.quantity, l.priceValue]), [
      ['gm-12-1', '상품1', 2, 5000],
      ['m1', '직접 담은', 3, 700],
    ]);
    assert.equal(d.updatedAt, new Date(h.clock.now()).toISOString());
  });

  it('명령 처리 중의 중간 상태는 draft 로 보내지 않고, ack 의 draft 가 최종 상태를 알린다', async () => {
    const h = await createHarness();
    await h.run(syncCmd(12, [line(12, 1), line(12, 2), line(12, 3)]));
    await h.clock.advance(10_000);
    assert.equal(h.transport.of('draft').length, 0);
    assert.equal(h.lastAck().draft!.lineCount, 3);
  });

  it('ack 직후 2초 안에 사용자가 바꾸면 2초가 지난 뒤에 보낸다', async () => {
    const h = await createHarness();
    await h.run(syncCmd(12, [line(12, 1)]));
    await h.clock.advance(1000);
    h.sdk.addManualLine('m1', '수동', 1, 1000, true);
    await settle();
    assert.equal(h.transport.of('draft').length, 0);
    await h.clock.advance(1000);
    assert.equal(h.transport.of('draft').length, 1);
  });

  it('명령 처리 중 사용자가 바꾼 내용은 ack 의 draft 에 반영되고 중복 draft 메시지는 없다', async () => {
    const h = await createHarness();
    let userEdited = false;
    h.sdk.hooks.addLineItem = () => {
      if (!userEdited) {
        userEdited = true;
        h.sdk.addManualLine('m1', '처리 중 사용자가 담음', 1, 900, true);
      }
    };
    await h.run(syncCmd(12, [line(12, 1)]));
    await h.clock.advance(5000);
    assert.equal(h.lastAck().draft!.lineCount, 2);
    assert.deepEqual(h.lastAck().draft!.ourKeys, ['gm-12-1']);
    assert.equal(h.transport.of('draft').length, 0);
  });
});

describe('연결/초기 상태', () => {
  it('시작 전에 받은 초기 draft 는 연결되면 한 번 보고한다(서버가 재시작했을 수도 있으니 재연결 때마다)', async () => {
    const h = await createHarness({ start: false });
    h.sdk.addManualLine('m1', '수동', 1, 1000);
    h.bridge.onDraftUpdate(h.sdk.snapshot());
    await h.bridge.start();
    h.transport.goOnline();
    await settle();
    assert.equal(h.transport.of('draft').length, 1);
    assert.equal(h.transport.of('draft')[0]!.draft.lineCount, 1);

    h.transport.goOffline();
    h.transport.goOnline();
    await settle();
    assert.equal(h.transport.of('draft').length, 2, '재연결 시 다시 한 번');
  });

  it('오프라인 동안 쌓인 draft 변경은 마지막 것 하나만 남겨 재연결 시 보낸다', async () => {
    const h = await createHarness();
    h.transport.goOffline();
    for (let i = 0; i < 5; i++) {
      await h.clock.advance(2500);
      h.sdk.addManualLine(`m${i}`, `수동${i}`, 1, 1000, true);
    }
    await settle();
    assert.equal(h.transport.of('draft').length, 0);
    assert.equal(h.bridge.getStatus().buffered, 1);
    h.transport.goOnline();
    await settle();
    const drafts = h.transport.of('draft');
    assert.equal(drafts.length, 1);
    assert.equal(drafts[0]!.draft.lineCount, 5);
  });
});
