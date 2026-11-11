import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Command } from '../../src/payment/protocol.ts';
import { logicalKeyOf } from '../../src/payment/protocol.ts';
import { settle } from './fake-clock.ts';
import { deferred } from './fake-sdk.ts';
import { clearCmd, createHarness, line, syncCmd } from './harness.ts';

describe('중복 command id', () => {
  it('이미 처리한 id 는 다시 처리하지 않고 저장해 둔 ack 를 다시 보낸다', async () => {
    const h = await createHarness();
    const cmd = syncCmd(12, [line(12, 1)], { id: 'cmd-100' });
    await h.run(cmd);
    assert.equal(h.sdk.callsOf('draftOrder.addLineItem').length, 1);
    const sentBefore = h.transport.sent.length;
    h.sdk.resetCalls();

    await h.run(cmd); // 서버가 ack 를 못 받아 다시 보냈다고 가정
    assert.deepEqual(h.sdk.callNames('draftOrder.'), [], '다시 처리하지 않는다');
    const acks = h.transport.acks();
    assert.equal(acks.length, 2);
    assert.equal(acks[1]!.commandId, 'cmd-100');
    assert.equal(acks[1]!.ok, true);
    assert.equal(h.transport.sent.length, sentBefore + 1);
    assert.equal(h.sdk.toasts.length, 1, '토스트도 다시 띄우지 않는다');
  });

  it('서버의 실제 id 형식(cmd-<epoch초 기반 seq>)도 문자열 그대로 다룬다', async () => {
    const h = await createHarness();
    const cmd = { ...syncCmd(12, [line(12, 1)], { id: 'cmd-1793705731' }), seq: 1793705731 };
    await h.run(cmd);
    await h.run(cmd);
    const acks = h.transport.acks();
    assert.deepEqual(acks.map((a) => [a.commandId, a.ok]), [
      ['cmd-1793705731', true],
      ['cmd-1793705731', true],
    ]);
    assert.equal(h.sdk.callsOf('draftOrder.addLineItem').length, 1);
    assert.deepEqual(h.ctxs[0]!.getHello('ws').processedIds, ['cmd-1793705731']);
  });

  it('실패했던 명령의 ack(ok:false + error)도 그대로 다시 보낸다', async () => {
    const h = await createHarness();
    h.sdk.hooks.addLineItem = () => {
      throw new Error('POS 오류');
    };
    const cmd = syncCmd(12, [line(12, 1)], { id: 'cmd-200' });
    await h.run(cmd);
    await h.run(cmd);
    const acks = h.transport.acks();
    assert.equal(acks.length, 2);
    assert.equal(acks[1]!.ok, false);
    assert.match(acks[1]!.error!, /POS 오류/);
    assert.equal(h.sdk.callsOf('draftOrder.addLineItem').length, 1, '같은 밑판이라 재시도도, 재처리도 없다');
  });

  it('superseded 로 처리된 명령의 ack 도 그대로 다시 보낸다', async () => {
    const h = await createHarness();
    const a = syncCmd(5, [line(5, 1)], { id: 'cmd-a' });
    const b = syncCmd(5, [line(5, 1), line(5, 2)], { id: 'cmd-b' });
    h.transport.sendCommand(a);
    h.transport.sendCommand(b); // 같은 틱 -> a 는 superseded
    await settle();
    assert.equal(h.ackFor('cmd-a')!.superseded, true);
    await h.run(a);
    const reAcks = h.transport.acks().filter((x) => x.commandId === 'cmd-a');
    assert.equal(reAcks.length, 2);
    assert.equal(reAcks[1]!.superseded, true);
  });

  it('처리 중이거나 큐에 있는 같은 id 가 다시 오면 무시한다', async () => {
    const h = await createHarness();
    const gate = deferred();
    h.sdk.hooks.addLineItem = () => gate.promise;
    const cmd = syncCmd(12, [line(12, 1)], { id: 'cmd-300' });
    const other = syncCmd(13, [line(13, 1)], { id: 'cmd-301' });
    h.transport.sendCommand(cmd);
    await settle();
    h.transport.sendCommand(other); // 큐 대기
    h.transport.sendCommand(cmd); // 처리 중 재전송
    h.transport.sendCommand(other); // 큐에 있는 것 재전송
    await settle();
    gate.resolve();
    await settle();
    const ids = h.transport.acks().map((a) => a.commandId);
    assert.deepEqual(ids, ['cmd-300', 'cmd-301']);
    assert.equal(h.sdk.callsOf('draftOrder.addLineItem').length, 2);
  });

  it('storage 에 저장된 처리 이력(gm.processed)으로 재시작 후에도 중복을 걸러낸다', async () => {
    const h1 = await createHarness();
    await h1.run(syncCmd(12, [line(12, 1)], { id: 'cmd-400' }));
    await h1.bridge.stop();
    const stored = JSON.parse(h1.sdk.store.get('gm.processed')!) as { id: string; ok: boolean }[];
    assert.deepEqual(stored.map((e) => e.id), ['cmd-400']);

    // 새 bridge(플러그인 재시작) - 같은 storage
    const h2 = await createHarness({ sdk: h1.sdk, clock: h1.clock, wire: false });
    h1.sdk.resetCalls();
    await h2.run(syncCmd(12, [line(12, 1)], { id: 'cmd-400' }));
    assert.deepEqual(h1.sdk.callNames('draftOrder.'), []);
    assert.equal(h2.transport.acks().length, 1);
    assert.equal(h2.transport.acks()[0]!.commandId, 'cmd-400');
    assert.equal(h2.transport.acks()[0]!.ok, true);
    // hello 의 processedIds 에도 포함
    assert.deepEqual(h2.ctxs[0]!.getHello('ws').processedIds, ['cmd-400']);
  });

  it('처리 이력은 storage 에 최근 100개, hello 의 processedIds 는 최근 50개만', async () => {
    const h = await createHarness();
    for (let i = 1; i <= 120; i++) h.transport.sendCommand(clearCmd(`c-${i}`));
    await settle(5);
    const stored = JSON.parse(h.sdk.store.get('gm.processed')!) as { id: string }[];
    assert.equal(stored.length, 100);
    assert.equal(stored[0]!.id, 'c-21');
    assert.equal(stored[99]!.id, 'c-120');
    const hello = h.ctxs[0]!.getHello('ws');
    assert.equal(hello.processedIds.length, 50);
    assert.equal(hello.processedIds[0], 'c-71');
    assert.equal(hello.processedIds[49], 'c-120');
    // 오래된 id 는 잊었으므로 다시 오면 새 명령으로 처리
    h.sdk.resetCalls();
    await h.run(clearCmd('c-1'));
    assert.equal(h.sdk.callsOf('draftOrder.get').length, 1); // 명령마다 실제 상태를 새로 읽는다(캐시를 쓰지 않음)
    assert.equal(h.transport.acks().filter((a) => a.commandId === 'c-1').length, 2);
  });
});

describe('큐: FIFO / coalesce', () => {
  it('서로 다른 작업의 명령은 도착 순서대로(FIFO) 하나씩 처리한다', async () => {
    const h = await createHarness();
    const order: string[] = [];
    h.sdk.hooks.addLineItem = (dto) => {
      order.push(logicalKeyOf(dto.key) ?? dto.key);
    };
    h.transport.sendCommand(syncCmd(1, [line(1, 1)], { id: 'k1' }));
    h.transport.sendCommand(syncCmd(2, [line(2, 1)], { id: 'k2' }));
    h.transport.sendCommand(syncCmd(3, [line(3, 1)], { id: 'k3' }));
    await settle();
    assert.deepEqual(order, ['gm-1-1', 'gm-2-1', 'gm-3-1']);
    assert.deepEqual(h.transport.acks().map((a) => [a.commandId, a.ok, a.superseded]), [
      ['k1', true, undefined],
      ['k2', true, undefined],
      ['k3', true, undefined],
    ]);
    assert.deepEqual(h.sdk.logicalKeys(), ['gm-3-1'], 'exclusive: 마지막 작업만 남는다');
  });

  it('같은 작업의 더 최신 SYNC_CART 가 큐에 있으면 건너뛰고 superseded ack, startPayment 는 최신 것에 합쳐진다', async () => {
    const h = await createHarness();
    const gate = deferred();
    let first = true;
    h.sdk.hooks.addLineItem = () => {
      if (first) {
        first = false;
        return gate.promise;
      }
    };
    // A 는 처리 중(게이트에서 대기)
    h.transport.sendCommand(syncCmd(5, [line(5, 1)], { id: 'A', startPayment: false }));
    await settle();
    // 처리 중에 B(결제 시작 요청), C(요청 없음), D(다른 작업)가 도착
    h.transport.sendCommand(syncCmd(5, [line(5, 1), line(5, 2)], { id: 'B', startPayment: true }));
    h.transport.sendCommand(syncCmd(5, [line(5, 1), line(5, 2), line(5, 3)], { id: 'C', startPayment: false }));
    h.transport.sendCommand(syncCmd(9, [line(9, 1)], { id: 'D', startPayment: false }));
    await settle();
    assert.equal(h.transport.acks().length, 0);
    gate.resolve();
    await settle();

    const acks = h.transport.acks();
    assert.deepEqual(acks.map((a) => a.commandId), ['A', 'B', 'C', 'D']);
    assert.equal(acks[0]!.superseded, undefined);
    assert.equal(acks[1]!.ok, true);
    assert.equal(acks[1]!.superseded, true, 'B 는 건너뜀');
    assert.equal(acks[2]!.superseded, undefined);
    assert.equal(acks[3]!.superseded, undefined);
    // C 가 B 의 startPayment 를 이어받아 결제 화면을 연다 (A, D 는 요청 없음)
    // 명령마다 get(시작) ... get(검증).
    // A: get, add(l1), get / C: get, add(l2), add(l3), get, startPayment / D: get, gm-5-* 삭제 3번, add, get
    assert.deepEqual(h.sdk.callNames('draftOrder.'), [
      'draftOrder.get',
      'draftOrder.addLineItem',
      'draftOrder.get',
      'draftOrder.get',
      'draftOrder.addLineItem',
      'draftOrder.addLineItem',
      'draftOrder.get',
      'draftOrder.startPayment',
      'draftOrder.get',
      'draftOrder.deleteLineItem',
      'draftOrder.deleteLineItem',
      'draftOrder.deleteLineItem',
      'draftOrder.addLineItem',
      'draftOrder.get',
    ]);
    // 최종 상태: D(작업 9) 만 남음
    assert.deepEqual(h.sdk.logicalKeys(), ['gm-9-1']);
  });

  it('같은 틱에 연달아 온 같은 작업 명령은 마지막 것만 처리하고 startPayment 를 OR 한다', async () => {
    const h = await createHarness();
    h.transport.sendCommand(syncCmd(5, [line(5, 1)], { id: 'a', startPayment: true }));
    h.transport.sendCommand(syncCmd(5, [line(5, 1, { quantity: 2 })], { id: 'b', startPayment: false }));
    h.transport.sendCommand(syncCmd(5, [line(5, 1, { quantity: 3 })], { id: 'c', startPayment: false }));
    await settle();
    const acks = h.transport.acks();
    assert.deepEqual(acks.map((a) => [a.commandId, a.superseded === true]), [
      ['a', true],
      ['b', true],
      ['c', false],
    ]);
    assert.deepEqual(h.sdk.callNames('draftOrder.'), [
      'draftOrder.get',
      'draftOrder.addLineItem',
      'draftOrder.get',
      'draftOrder.startPayment',
    ]);
    assert.equal(h.sdk.lines[0]!.quantity, 3);
  });

  it('다른 작업의 SYNC_CART 는 서로 건너뛰지 않는다', async () => {
    const h = await createHarness();
    h.transport.sendCommand(syncCmd(5, [line(5, 1)], { id: 'x' }));
    h.transport.sendCommand(syncCmd(6, [line(6, 1)], { id: 'y' }));
    await settle();
    assert.equal(h.transport.acks().some((a) => a.superseded), false);
  });
});

describe('명령 하나의 실패가 큐를 멈추지 않는다', () => {
  it('실패 ack + 오류 토스트, 다음 명령은 정상 처리', async () => {
    const h = await createHarness();
    let n = 0;
    h.sdk.hooks.addLineItem = () => {
      if (n++ < 1) throw new Error('첫 명령은 실패');
    };
    h.transport.sendCommand(syncCmd(1, [line(1, 1)], { id: 'bad' }));
    h.transport.sendCommand(syncCmd(2, [line(2, 1)], { id: 'good' }));
    await settle();
    const acks = h.transport.acks();
    assert.deepEqual(acks.map((a) => [a.commandId, a.ok]), [
      ['bad', false],
      ['good', true],
    ]);
    assert.match(acks[0]!.error!, /첫 명령은 실패/);
    assert.equal(h.sdk.toasts.filter((t) => t.kind === 'error').length, 1);
    assert.match(h.sdk.toasts[0]!.message, /1가1234 홍길동 처리에 실패했어요/);
    assert.deepEqual(h.sdk.logicalKeys(), ['gm-2-1']);
  });

  it('잘못된 페이로드 / 알 수 없는 종류는 SDK 를 건드리지 않고 ok:false', async () => {
    const h = await createHarness();
    const bad: Command = { id: 'bad-1', seq: 1, kind: 'SYNC_CART', createdAt: '', payload: { lines: 'x' } as never };
    const unknown: Command = { id: 'bad-2', seq: 2, kind: 'REBOOT' as never, createdAt: '', payload: {} as never };
    const badClear: Command = { id: 'bad-3', seq: 3, kind: 'CLEAR_CART', createdAt: '', payload: { scope: 'all' } as never };
    for (const c of [bad, unknown, badClear]) h.transport.sendCommand(c);
    await settle();
    const acks = h.transport.acks();
    assert.deepEqual(acks.map((a) => [a.commandId, a.ok]), [
      ['bad-1', false],
      ['bad-2', false],
      ['bad-3', false],
    ]);
    assert.match(acks[1]!.error!, /지원하지 않는 명령/);
    assert.deepEqual(h.sdk.callNames('draftOrder.'), []);
  });
});
