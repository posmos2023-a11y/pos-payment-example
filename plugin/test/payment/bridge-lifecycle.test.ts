import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createBridge } from '../../src/payment/bridge.ts';
import { EMPTY_URL_WARNING } from '../../src/payment/settings.ts';
import { FakeClock, settle } from './fake-clock.ts';
import { FakeSdk } from './fake-sdk.ts';
import { FakeTransport, createHarness, line, syncCmd } from './harness.ts';

describe('clientId / hello', () => {
  it('clientId 를 만들어 storage(gm.clientId)에 저장하고 다시 시작해도 재사용한다', async () => {
    const h1 = await createHarness();
    assert.equal(h1.sdk.store.get('gm.clientId'), 'pos-test-client-0001');
    assert.equal(h1.bridge.getStatus().clientId, 'pos-test-client-0001');
    await h1.bridge.stop();

    const h2 = await createHarness({
      sdk: h1.sdk,
      clock: h1.clock,
      wire: false,
      bridge: { randomId: () => 'SHOULD-NOT-BE-USED' },
    });
    assert.equal(h2.bridge.getStatus().clientId, 'pos-test-client-0001');
    assert.equal(h2.ctxs[0]!.clientId, 'pos-test-client-0001');
  });

  it('기본 clientId 생성기는 무작위 문자열을 만든다', async () => {
    const sdk = new FakeSdk();
    sdk.settingValues = { serverUrl: 'http://x:1' };
    const ids = new Set<string>();
    for (let i = 0; i < 3; i++) {
      sdk.store.clear();
      const bridge = createBridge({
        sdk,
        clock: new FakeClock(),
        transportFactory: () => new FakeTransport(),
      });
      await bridge.start();
      ids.add(bridge.getStatus().clientId);
      await bridge.stop();
    }
    assert.equal(ids.size, 3);
    for (const id of ids) assert.match(id, /^pos-[0-9a-f]{16}$/);
  });

  it('storage 가 망가져도 동작한다', async () => {
    const sdk = new FakeSdk();
    sdk.failStorage = true;
    const h = await createHarness({ sdk });
    assert.equal(h.bridge.getStatus().clientId, 'pos-test-client-0001');
    await h.run(syncCmd(1, [line(1, 1)]));
    assert.equal(h.lastAck().ok, true);
  });

  it('hello 내용: clientId / pluginName / pluginVersion / transport / processedIds', async () => {
    const h = await createHarness({ bridge: { pluginName: () => '내 플러그인', pluginVersion: '1.2.3' } });
    await h.run(syncCmd(1, [line(1, 1)], { id: 'cmd-7' }));
    assert.deepEqual(h.ctxs[0]!.getHello('http'), {
      type: 'hello',
      clientId: 'pos-test-client-0001',
      merchantId: '4242',
      pluginName: '내 플러그인',
      pluginVersion: '1.2.3',
      transport: 'http',
      processedIds: ['cmd-7'],
    });
  });
});

describe('설정: serverUrl 이 비어 있을 때', () => {
  it('경고 토스트를 한 번만 띄우고 전송 계층을 시작하지 않으며, 주소를 넣으면 시작한다', async () => {
    const h = await createHarness({ settings: { serverUrl: '' } });
    assert.equal(h.transports.length, 0);
    assert.deepEqual(h.sdk.toasts, [{ kind: 'warn', message: EMPTY_URL_WARNING }]);

    await h.bridge.reloadSettings(); // 여전히 비어 있음
    h.sdk.emitSettingChange();
    await settle();
    assert.equal(h.sdk.toasts.length, 1, '1회만');
    assert.equal(h.transports.length, 0);

    h.sdk.settingValues = { ...h.sdk.settingValues, serverUrl: '192.168.0.10:8765/' };
    h.sdk.emitSettingChange(); // setting.on('change')
    await settle();
    assert.equal(h.transports.length, 1);
    assert.equal(h.ctxs[0]!.settings.serverUrl, 'http://192.168.0.10:8765');
    assert.equal(h.ctxs[0]!.settings.wsUrl, 'ws://192.168.0.10:8765/pos/ws');
    assert.equal(h.transports[0]!.started, true);
    assert.equal(h.sdk.toasts.length, 1);
  });

  it('showToast 가 꺼져 있어도 주소 미입력 안내는 띄운다(설정 안내)', async () => {
    const h = await createHarness({ settings: { serverUrl: '', showToast: false } });
    assert.equal(h.sdk.toasts.length, 1);
  });
});

describe('설정 다시 읽기', () => {
  it('서버 주소/토큰/연결 방식이 바뀌면 기존 연결을 정리하고 새로 시작한다', async () => {
    const h = await createHarness();
    const first = h.transport;
    h.sdk.settingValues = { ...h.sdk.settingValues, serverUrl: 'https://pos.example.com', token: 'abc', transport: 'http' };
    h.sdk.emitSettingChange();
    await settle();
    assert.equal(first.stopped, true);
    assert.equal(h.transports.length, 2);
    const ctx = h.ctxs[1]!;
    assert.equal(ctx.settings.serverUrl, 'https://pos.example.com');
    assert.equal(ctx.settings.wsUrl, 'wss://pos.example.com/pos/ws');
    assert.equal(ctx.settings.token, 'abc');
    assert.equal(ctx.settings.transport, 'http');
    assert.equal(h.bridge.getStatus().online, false, '새 연결이 welcome 을 받기 전까지 offline');
    h.transport.goOnline();
    assert.equal(h.bridge.getStatus().online, true);
  });

  it('옛 전송 계층의 늦은 이벤트는 무시한다', async () => {
    const h = await createHarness();
    const first = h.transport;
    h.sdk.settingValues = { ...h.sdk.settingValues, serverUrl: 'http://other:1' };
    h.sdk.emitSettingChange();
    await settle();
    first.sendCommand(syncCmd(1, [line(1, 1)]));
    await settle();
    assert.equal(h.sdk.callsOf('draftOrder.addLineItem').length, 0);
  });

  it('연결과 무관한 설정(알림/결제 자동열기 등)만 바뀌면 연결을 다시 만들지 않고 바로 적용한다', async () => {
    const h = await createHarness();
    h.sdk.settingValues = { ...h.sdk.settingValues, showToast: false, allowStartPayment: false };
    h.sdk.emitSettingChange();
    await settle();
    assert.equal(h.transports.length, 1);
    assert.equal(h.transport.stopped, false);
    await h.run(syncCmd(1, [line(1, 1)], { startPayment: true }));
    assert.equal(h.sdk.callsOf('draftOrder.startPayment').length, 0);
    assert.deepEqual(h.sdk.toasts, []);
  });

  it('설정을 읽지 못하면 이전 설정을 유지한다', async () => {
    const h = await createHarness();
    h.sdk.setting.getValues = async () => {
      throw new Error('설정 오류');
    };
    h.sdk.emitSettingChange();
    await settle();
    assert.equal(h.transports.length, 1);
    assert.equal(h.transport.stopped, false);
  });
});

describe('송신 버퍼', () => {
  it('오프라인 동안 쌓인 메시지는 재연결 시 ack/payment.* 를 먼저 보낸다', async () => {
    const h = await createHarness();
    h.transport.goOffline();
    h.bridge.onCancel('pay-1', 'ord-1');
    h.sdk.addManualLine('m1', '수동', 1, 1000, true); // draft (우선순위 낮음)
    h.sdk.setOrder('ord-2', 0, 1);
    await h.bridge.onPaid('pay-2', 'ord-2');
    await settle();
    assert.equal(h.transport.sent.length, 0);
    assert.equal(h.bridge.getStatus().buffered, 3);

    h.transport.goOnline();
    await settle();
    assert.deepEqual(h.transport.sent.map((m) => m.type), ['payment.cancelled', 'payment.paid', 'draft']);
    assert.equal(h.bridge.getStatus().buffered, 0);
  });

  it('오프라인 중에 처리된 명령의 ack 는 보관했다가 재연결 시 보낸다', async () => {
    const h = await createHarness();
    const gate = (await import('./fake-sdk.ts')).deferred();
    h.sdk.hooks.addLineItem = () => gate.promise;
    h.transport.sendCommand(syncCmd(1, [line(1, 1)], { id: 'cmd-1' }));
    await settle();
    h.transport.goOffline();
    gate.resolve();
    await settle();
    assert.equal(h.transport.acks().length, 0);
    h.transport.goOnline();
    await settle();
    assert.deepEqual(h.transport.acks().map((a) => [a.commandId, a.ok]), [['cmd-1', true]]);
  });

  it('최대 100개까지만 보관하고, 넘치면 ack/payment.* 가 아닌 것부터 버린다', async () => {
    const h = await createHarness();
    h.transport.goOffline();
    h.sdk.setOrder('ord-1', 0, 1);
    for (let i = 0; i < 130; i++) h.bridge.onCancel(`pay-${i}`, 'ord-1');
    assert.equal(h.bridge.getStatus().buffered, 100);
    h.transport.goOnline();
    await settle();
    const cancelled = h.transport.of('payment.cancelled');
    assert.equal(cancelled.length, 100);
    assert.equal(cancelled[0]!.paymentId, 'pay-30', '가장 오래된 것부터 버려진다');
  });

  it('flush 도중 전송 계층이 거부하면 나머지를 다시 보관한다', async () => {
    const h = await createHarness();
    h.transport.goOffline();
    for (let i = 0; i < 3; i++) h.bridge.onCancel(`pay-${i}`, 'ord-1');
    // 처음 한 개만 받아 주고 이후 거부
    let accepted = 0;
    const realSend = h.transport.send.bind(h.transport);
    h.transport.send = (msg) => (accepted++ < 1 ? realSend(msg) : false);
    h.transport.goOnline();
    await settle();
    assert.equal(h.transport.sent.length, 1);
    assert.equal(h.bridge.getStatus().buffered, 2);
  });
});

describe('서버 메시지 / 종료', () => {
  it('UNAUTHORIZED 오류는 토큰 안내 토스트를 (반복하지 않고) 띄운다', async () => {
    const h = await createHarness();
    h.transport.serverSend({ type: 'error', code: 'UNAUTHORIZED', message: 'x' });
    h.transport.serverSend({ type: 'error', code: 'UNAUTHORIZED', message: 'x' });
    assert.equal(h.sdk.toasts.length, 1);
    assert.equal(h.sdk.toasts[0]!.kind, 'error');
    assert.match(h.sdk.toasts[0]!.message, /토큰/);
    h.transport.serverSend({ type: 'error', code: 'SOMETHING', message: 'x' });
    assert.equal(h.sdk.toasts.length, 1);
  });

  it('welcome 은 무시해도 되는 정보 메시지', async () => {
    const h = await createHarness();
    h.transport.serverSend({ type: 'welcome', serverVersion: '1.0.0', serverTime: 't' });
    assert.equal(h.transport.sent.length, 0);
  });

  it('stop() 은 전송 계층을 정리하고 타이머를 남기지 않는다', async () => {
    const h = await createHarness();
    h.sdk.addManualLine('m1', '수동', 1, 1000, true);
    h.sdk.addManualLine('m2', '수동', 1, 1000, true);
    await h.bridge.stop();
    assert.equal(h.transport.stopped, true);
    assert.equal(h.clock.pendingTimers, 0);
    // 종료 후 이벤트가 와도 예외가 나지 않는다
    h.sdk.emitDraftUpdate();
    h.sdk.emitCancel('p', 'o');
    await settle();
  });
});
