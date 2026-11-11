import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isRateLimitError } from '../../src/payment/bridge.ts';
import { settle } from './fake-clock.ts';
import { FakeRateLimitError } from './fake-sdk.ts';
import { createHarness, line, syncCmd } from './harness.ts';

const RATE_LIMIT_TEXT = '해당 기능은 60초당 100회만 호출할 수 있습니다';

describe('isRateLimitError', () => {
  it('SDK 의 정적 판별 함수 / name / 메시지 중 하나라도 맞으면 호출 제한 오류', () => {
    assert.equal(isRateLimitError(new FakeRateLimitError()), true);
    assert.equal(isRateLimitError(new FakeRateLimitError('아무 메시지')), true);
    assert.equal(isRateLimitError(new Error(RATE_LIMIT_TEXT)), true);
    assert.equal(isRateLimitError(Object.assign(new Error('x'), { name: 'PosPluginSdkRateLimitError' })), true);
    assert.equal(isRateLimitError(RATE_LIMIT_TEXT), true);
    assert.equal(isRateLimitError({ message: `해당 기능은 1800초당 200회만 호출할 수 있습니다` }), true);
  });
  it('그 밖의 오류는 아니다', () => {
    assert.equal(isRateLimitError(new Error('다른 오류')), false);
    assert.equal(isRateLimitError(null), false);
    assert.equal(isRateLimitError(undefined), false);
    assert.equal(isRateLimitError(42), false);
  });
});

describe('호출 제한(rate limit) 재시도', () => {
  it('15초 대기 후 같은 명령을 다시 시도한다 (정적 판별 함수로 인식)', async () => {
    const h = await createHarness();
    let n = 0;
    h.sdk.hooks.addLineItem = () => {
      if (n++ < 2) throw new FakeRateLimitError();
    };
    h.transport.sendCommand(syncCmd(12, [line(12, 1)], { id: 'cmd-rl' }));
    await settle();
    assert.equal(h.sdk.callsOf('draftOrder.addLineItem').length, 1);
    assert.equal(h.transport.acks().length, 0, '아직 ack 없음');

    await h.clock.advance(14_999);
    assert.equal(h.sdk.callsOf('draftOrder.addLineItem').length, 1);
    await h.clock.advance(1);
    assert.equal(h.sdk.callsOf('draftOrder.addLineItem').length, 2, '15초 뒤 재시도(또 제한)');
    assert.equal(h.transport.acks().length, 0);
    await h.clock.advance(15_000);
    assert.equal(h.sdk.callsOf('draftOrder.addLineItem').length, 3);

    const acks = h.transport.acks();
    assert.equal(acks.length, 1);
    assert.equal(acks[0]!.ok, true);
    assert.deepEqual(h.sdk.logicalKeys(), ['gm-12-1'], '중복 없이 한 번만 추가');
    assert.equal(
      h.sdk.callsOf('draftOrder.get').length,
      4,
      '명령을 시작할 때마다 get() 으로 실제 상태를 읽고(재시도 3회), 끝나면 검증용으로 한 번 더 읽는다',
    );
    assert.equal(h.sdk.callsOf('category.getCategories').length, 0, '호출 제한은 카테고리 폴백 대상이 아니다');
  });

  it('메시지 또는 name 만으로도 호출 제한으로 인식한다', async () => {
    for (const make of [
      () => new Error(RATE_LIMIT_TEXT),
      () => Object.assign(new Error('제한'), { name: 'PosPluginSdkRateLimitError' }),
    ]) {
      const h = await createHarness();
      let n = 0;
      h.sdk.hooks.addLineItem = () => {
        if (n++ < 1) throw make();
      };
      h.transport.sendCommand(syncCmd(12, [line(12, 1)]));
      await settle();
      assert.equal(h.transport.acks().length, 0);
      await h.clock.advance(15_000);
      assert.equal(h.lastAck().ok, true);
    }
  });

  it('최대 4번 재시도하고(총 5번 시도) 그래도 안 되면 ack ok:false', async () => {
    const h = await createHarness();
    h.sdk.hooks.addLineItem = () => {
      throw new FakeRateLimitError();
    };
    h.transport.sendCommand(syncCmd(12, [line(12, 1)], { id: 'cmd-rl2' }));
    await settle();
    for (let attempt = 2; attempt <= 5; attempt++) {
      await h.clock.advance(15_000);
      assert.equal(h.sdk.callsOf('draftOrder.addLineItem').length, attempt);
      if (attempt < 5) assert.equal(h.transport.acks().length, 0);
    }
    const acks = h.transport.acks();
    assert.equal(acks.length, 1);
    assert.equal(acks[0]!.ok, false);
    assert.match(acks[0]!.error!, /회만 호출할 수 있습니다/);
    assert.equal(h.sdk.toasts.filter((t) => t.kind === 'error').length, 1);
    await h.clock.advance(60_000);
    assert.equal(h.sdk.callsOf('draftOrder.addLineItem').length, 5, '더는 재시도하지 않는다');
  });

  it('카탈로그 조회가 호출 제한에 걸려도 명령을 15초 뒤 다시 시도한다', async () => {
    const h = await createHarness();
    let n = 0;
    h.sdk.catalogHook = () => {
      if (n++ < 1) throw new FakeRateLimitError();
    };
    h.transport.sendCommand(syncCmd(12, [line(12, 1)]));
    await settle();
    assert.equal(h.transport.acks().length, 0);
    await h.clock.advance(15_000);
    assert.equal(h.sdk.callsOf('catalog.getCatalogs').length, 2);
    assert.equal(h.lastAck().ok, true);
  });

  it('대기하는 동안 뒤에 온 명령은 순서를 지켜 기다리고, 같은 id 재전송은 무시한다', async () => {
    const h = await createHarness();
    let n = 0;
    h.sdk.hooks.addLineItem = () => {
      if (n++ < 1) throw new FakeRateLimitError();
    };
    const first = syncCmd(1, [line(1, 1)], { id: 'first' });
    h.transport.sendCommand(first);
    await settle();
    h.transport.sendCommand(syncCmd(2, [line(2, 1)], { id: 'second' }));
    h.transport.sendCommand(first); // 서버가 30초 ack 타임아웃으로 재전송했다고 가정
    await settle();
    assert.equal(h.transport.acks().length, 0);
    await h.clock.advance(15_000);
    assert.deepEqual(h.transport.acks().map((a) => a.commandId), ['first', 'second']);
    assert.equal(h.sdk.callsOf('draftOrder.addLineItem').length, 3);
  });

  it('stop() 하면 대기 중이던 재시도를 포기한다', async () => {
    const h = await createHarness();
    h.sdk.hooks.addLineItem = () => {
      throw new FakeRateLimitError();
    };
    h.transport.sendCommand(syncCmd(12, [line(12, 1)]));
    await settle();
    await h.bridge.stop();
    await h.clock.advance(5 * 60_000);
    assert.equal(h.sdk.callsOf('draftOrder.addLineItem').length, 1);
    assert.equal(h.transport.acks().length, 0);
  });
});

describe('log 메시지(분당 최대 5개)', () => {
  it('실패 보고는 분당 5개까지만 서버로 보낸다', async () => {
    const h = await createHarness();
    h.sdk.hooks.addLineItem = () => {
      throw new Error('실패');
    };
    for (let i = 1; i <= 7; i++) h.transport.sendCommand(syncCmd(i, [line(i, 1)], { id: `f${i}` }));
    await settle();
    assert.equal(h.transport.acks().filter((a) => !a.ok).length, 7);
    const logs = h.transport.of('log');
    assert.equal(logs.length, 5);
    assert.equal(logs[0]!.level, 'error');
    assert.match(logs[0]!.message, /f1/);

    await h.clock.advance(61_000);
    h.transport.sendCommand(syncCmd(8, [line(8, 1)], { id: 'f8' }));
    await settle();
    assert.equal(h.transport.of('log').length, 6, '1분이 지나면 다시 보낼 수 있다');
  });
});

describe('알림(showToast)', () => {
  it('showToast 가 꺼져 있으면 성공/실패 토스트를 띄우지 않는다', async () => {
    const h = await createHarness({ settings: { showToast: false } });
    await h.run(syncCmd(1, [line(1, 1)]));
    h.sdk.hooks.addLineItem = () => {
      throw new Error('실패');
    };
    await h.run(syncCmd(2, [line(2, 1)]));
    assert.equal(h.lastAck().ok, false);
    assert.deepEqual(h.sdk.toasts, []);
  });
});
