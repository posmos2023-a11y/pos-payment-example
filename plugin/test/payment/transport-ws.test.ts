import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { WsTransport } from '../../src/payment/transport.ts';
import { FakeClock, settle } from './fake-clock.ts';
import { FakeSdk, deferred } from './fake-sdk.ts';
import { ACK_MSG, WELCOME, makeRig } from './transport-helpers.ts';
import { last } from './util.ts';

async function connected(opts: { token?: string } = {}) {
  const clock = new FakeClock();
  const sdk = new FakeSdk();
  const rig = makeRig(sdk, clock, opts.token ? { token: opts.token } : {});
  const t = new WsTransport(rig.deps);
  rig.start(t);
  await settle();
  const ws = sdk.sockets[0]!;
  return { clock, sdk, rig, t, ws };
}

async function welcomed(opts: { token?: string } = {}) {
  const c = await connected(opts);
  c.ws.serverSend(WELCOME);
  await settle();
  return c;
}

describe('WsTransport: 연결과 hello', () => {
  it('create(url, headers, {timeout:5000}) 로 연결하고, connect() 를 다시 부르지 않는다', async () => {
    const { sdk, ws } = await connected();
    assert.equal(sdk.createRequests.length, 1);
    assert.match(sdk.createRequests[0]!.url, /^ws:\/\/host:8765\/pos\/ws\?c=1-[0-9a-z]{6}$/);
    assert.deepEqual(sdk.createRequests[0]!.options, { timeout: 5000 });
    assert.deepEqual(sdk.createRequests[0]!.headers, {}); // 토큰 없으면 Authorization 없음
    assert.equal(ws.connectCalls, 0, 'create() 가 이미 connect 했으므로 다시 부르면 안 된다');
  });

  it('토큰이 있으면 Authorization: Bearer 헤더', async () => {
    const { sdk } = await connected({ token: 's3cret' });
    assert.deepEqual(sdk.createRequests[0]!.headers, { Authorization: 'Bearer s3cret' });
  });

  it('핸들러를 등록하고 hello 를 보낸다', async () => {
    const { ws } = await connected();
    assert.equal(typeof ws.onMessageCb, 'function');
    assert.equal(typeof ws.onCloseCb, 'function');
    assert.equal(typeof ws.onErrorCb, 'function');
    assert.equal(ws.sent.length, 1);
    assert.deepEqual(ws.sent[0], {
      type: 'hello',
      clientId: 'client-1',
      pluginName: 'example-test',
      pluginVersion: '1.0.0',
      transport: 'ws',
      processedIds: ['cmd-1', 'cmd-2'],
    });
  });

  it('welcome 을 받기 전에는 online 이 아니고 send 는 false', async () => {
    const { t, rig, ws } = await connected();
    assert.equal(rig.statuses.some((s) => s.online), false);
    assert.equal(t.send(ACK_MSG), false);
    assert.equal(ws.sent.length, 1, '아직 hello 외에는 아무것도 보내지 않는다');
  });

  it('welcome 을 받으면 online, 이후 send 는 소켓으로 나간다', async () => {
    const { t, rig, ws } = await welcomed();
    assert.deepEqual(rig.statuses, [{ kind: 'ws', online: true }]);
    assert.deepEqual(rig.messages, [WELCOME]);
    assert.equal(t.send(ACK_MSG), true);
    assert.deepEqual(ws.sent[1], ACK_MSG);
  });

  it('command / error 메시지는 그대로 전달하고, 깨진 메시지는 무시', async () => {
    const { rig, ws } = await welcomed();
    ws.serverSend('이건 JSON 이 아님');
    ws.serverSend({ type: 'nope' });
    ws.serverSend({ type: 'error', code: 'UNAUTHORIZED', message: 'x' });
    ws.serverSend({
      type: 'command',
      command: { id: 'cmd-3', seq: 3, kind: 'CLEAR_CART', createdAt: 't', payload: { scope: 'ours' } },
    });
    await settle();
    assert.deepEqual(
      rig.messages.map((m) => m.type),
      ['welcome', 'error', 'command'],
    );
  });
});

describe('WsTransport: ping / watchdog', () => {
  it('ping 에 같은 t 로 pong 을 보낸다(전달은 하지 않음)', async () => {
    const { rig, ws } = await welcomed();
    ws.serverSend({ type: 'ping', t: 1730000000 });
    ws.serverSend({ type: 'ping', t: 'abc' });
    assert.deepEqual(ws.sentOfType('pong'), [
      { type: 'pong', t: 1730000000 },
      { type: 'pong', t: 'abc' },
    ]);
    assert.equal(rig.messages.some((m) => m.type === 'ping'), false);
  });

  it('70초 동안 메시지가 없으면 열려 있다고 믿는 소켓을 disconnect 한 뒤 다시 연결한다', async () => {
    const { clock, sdk, ws, rig } = await welcomed();
    await clock.advance(69_999);
    assert.equal(sdk.sockets.length, 1);
    assert.equal(ws.disconnectCalls, 0);
    await clock.advance(1); // 70초
    assert.equal(ws.disconnectCalls, 1, '아직 close 이벤트가 없었으므로 disconnect 를 먼저 부른다');
    assert.equal(sdk.sockets.length, 1, '백오프(2초) 전에는 새 소켓을 만들지 않는다');
    assert.equal(last(rig.statuses).online, false);
    assert.equal(last(rig.statuses).failed, true);
    await clock.advance(2000);
    assert.equal(sdk.sockets.length, 2);
    assert.equal(sdk.sockets[1]!.connectCalls, 0);
    assert.equal(sdk.sockets[1]!.sentOfType('hello').length, 1);
  });

  it('메시지를 받을 때마다 워치독이 다시 시작된다', async () => {
    const { clock, sdk, ws } = await welcomed();
    await clock.advance(60_000);
    ws.serverSend({ type: 'ping', t: 1 });
    await clock.advance(60_000); // 마지막 메시지로부터 60초
    assert.equal(sdk.sockets.length, 1);
    assert.equal(ws.disconnectCalls, 0);
    await clock.advance(10_001); // 마지막 메시지로부터 70초 초과
    assert.equal(ws.disconnectCalls, 1);
  });
});

describe('WsTransport: 재연결과 백오프', () => {
  it('close 이벤트로 끊기면 옛 URL 을 best-effort 로 한 번 disconnect 하고(기다리지 않음) 2초 뒤 다시 연결한다', async () => {
    const { clock, sdk, ws, t } = await welcomed();
    ws.serverClose('1006');
    await settle();
    assert.equal(ws.disconnectCalls, 1, '호스트의 소켓 목록을 치운다(URL 이 고유해서 새 소켓은 영향받지 않는다)');
    assert.equal(t.send(ACK_MSG), false);
    await clock.advance(1999);
    assert.equal(sdk.sockets.length, 1);
    await clock.advance(1);
    assert.equal(sdk.sockets.length, 2);
    assert.equal(ws.disconnectCalls, 1);
    assert.equal(sdk.sockets[1]!.disconnectCalls, 0, '새 소켓은 건드리지 않는다');
  });

  it('연결 실패 백오프: 2,4,8,16,32,60,60초', async () => {
    const clock = new FakeClock();
    const sdk = new FakeSdk();
    sdk.createPlan = Array.from({ length: 8 }, () => new Error('연결 거부'));
    const rig = makeRig(sdk, clock);
    const t = new WsTransport(rig.deps);
    rig.start(t);
    await settle();
    assert.equal(sdk.createRequests.length, 1); // t=0
    const expectAt = [2000, 6000, 14_000, 30_000, 62_000, 122_000, 182_000];
    let elapsed = 0;
    for (let i = 0; i < expectAt.length; i++) {
      const target = expectAt[i]!;
      await clock.advance(target - elapsed - 1);
      assert.equal(sdk.createRequests.length, i + 1, `${target}ms 직전에는 ${i + 1}번째 시도까지만`);
      await clock.advance(1);
      assert.equal(sdk.createRequests.length, i + 2, `${target}ms 에 ${i + 2}번째 시도`);
      elapsed = target;
    }
    assert.equal(rig.statuses.filter((s) => s.failed).length, 8);
    await t.stop();
  });

  it('토큰이 틀려 서버가 업그레이드 전에 401 로 거절하면(create 실패) 토큰 안내를 한 번만 알린다', async () => {
    const clock = new FakeClock();
    const sdk = new FakeSdk();
    sdk.createPlan = [
      new Error('WebSocket connection failed: HTTP 401 Unauthorized'),
      new Error('Unexpected server response: 401'),
      new Error('연결 거부(ECONNREFUSED)'),
    ];
    const rig = makeRig(sdk, clock, { token: 'wrong' });
    const t = new WsTransport(rig.deps);
    rig.start(t);
    await settle();
    assert.equal(rig.notifications.length, 1);
    assert.equal(rig.notifications[0]![0], 'error');
    assert.match(rig.notifications[0]![1], /토큰/);
    await clock.advance(2000); // 두 번째 401 -> 10분 안에는 반복하지 않는다
    await clock.advance(4000); // 일반 연결 실패 -> 알리지 않는다
    assert.equal(rig.notifications.length, 1);
    assert.equal(sdk.createRequests.length, 3);
    assert.equal(last(rig.statuses).failed, true, '재시도는 백오프로 계속');
    await t.stop();
  });

  it('welcome 을 받으면 백오프가 초기화된다', async () => {
    const clock = new FakeClock();
    const sdk = new FakeSdk();
    sdk.createPlan = [new Error('x'), new Error('x')]; // 2초, 4초 대기 후 세 번째에 성공
    const rig = makeRig(sdk, clock);
    const t = new WsTransport(rig.deps);
    rig.start(t);
    await settle();
    await clock.advance(2000);
    await clock.advance(4000);
    assert.equal(sdk.sockets.length, 1);
    sdk.sockets[0]!.serverSend(WELCOME);
    await settle();
    sdk.sockets[0]!.serverClose();
    await settle();
    await clock.advance(1999);
    assert.equal(sdk.sockets.length, 1);
    await clock.advance(1);
    assert.equal(sdk.sockets.length, 2, '실패 횟수가 0 으로 돌아가 다음 대기는 2초');
    await t.stop();
  });

  it('welcome 없이 닫히기만 반복하면 백오프가 커진다', async () => {
    const { clock, sdk } = await connected();
    sdk.sockets[0]!.serverClose();
    await clock.advance(2000);
    assert.equal(sdk.sockets.length, 2);
    sdk.sockets[1]!.serverClose();
    await clock.advance(3999);
    assert.equal(sdk.sockets.length, 2);
    await clock.advance(1);
    assert.equal(sdk.sockets.length, 3);
  });

  it('이전 소켓의 늦은 close 이벤트는 무시한다', async () => {
    const { clock, sdk, ws } = await welcomed();
    ws.serverClose();
    await clock.advance(2000);
    assert.equal(sdk.sockets.length, 2);
    ws.serverClose(); // 이미 교체된 옛 소켓
    ws.serverSend(WELCOME);
    await clock.advance(10_000);
    assert.equal(sdk.sockets.length, 2, '옛 소켓 이벤트로 재연결이 또 일어나면 안 된다');
  });
});

describe('WsTransport: stop', () => {
  it('열려 있다고 믿는 소켓이면 disconnect 를 한 번 부르고 더는 재연결하지 않는다', async () => {
    const { clock, sdk, ws, t } = await welcomed();
    await t.stop();
    assert.equal(ws.disconnectCalls, 1);
    await clock.advance(5 * 60_000);
    assert.equal(sdk.sockets.length, 1);
    assert.equal(clock.pendingTimers, 0);
  });

  it('이미 close 로 끊긴 소켓은 끊김 처리 때 한 번 disconnect 했으니 stop 에서 다시 부르지 않는다', async () => {
    const { sdk, ws, t } = await welcomed();
    ws.serverClose();
    await settle();
    assert.equal(ws.disconnectCalls, 1);
    await t.stop();
    assert.equal(ws.disconnectCalls, 1);
    assert.equal(sdk.sockets.length, 1);
  });

  it('연결 중에 stop 하면 연결이 끝난 뒤 그 소켓을 정리한다', async () => {
    const clock = new FakeClock();
    const sdk = new FakeSdk();
    const gate = deferred();
    sdk.createPlan = [() => gate.promise];
    const rig = makeRig(sdk, clock);
    const t = new WsTransport(rig.deps);
    rig.start(t);
    await settle();
    const stopping = t.stop();
    await settle();
    gate.resolve();
    await stopping;
    assert.equal(sdk.sockets.length, 1);
    assert.equal(sdk.sockets[0]!.disconnectCalls, 1);
    assert.equal(sdk.sockets[0]!.sent.length, 0, 'stop 된 뒤에는 hello 도 보내지 않는다');
    assert.equal(clock.pendingTimers, 0);
  });

  it('stop 후에는 상태/메시지 콜백이 오지 않는다', async () => {
    const { rig, ws, t } = await welcomed();
    const before = rig.statuses.length;
    await t.stop();
    ws.serverSend(WELCOME);
    ws.serverClose();
    assert.equal(rig.statuses.length, before);
  });
});

// ---------------------------------------------------------------------------
// hello 재전송 / welcome 대기 제한
// ---------------------------------------------------------------------------

describe('WsTransport: hello 재전송과 welcome 대기 제한', () => {
  it('hello 는 create 직후, onOpen 시, welcome 을 받을 때까지 3초마다 다시 보낸다', async () => {
    const { clock, ws } = await connected();
    assert.equal(ws.sentOfType('hello').length, 1, 'create 직후');
    await clock.advance(2999);
    assert.equal(ws.sentOfType('hello').length, 1);
    await clock.advance(1); // t=3s
    assert.equal(ws.sentOfType('hello').length, 2, '3초마다');

    ws.serverOpen(); // 호스트가 소켓을 연 뒤에 알려 준다
    assert.equal(ws.sentOfType('hello').length, 3, 'onOpen 시 즉시');
    await clock.advance(2999);
    assert.equal(ws.sentOfType('hello').length, 3, 'onOpen 으로 다시 보냈으니 재전송 시계도 거기서부터');
    await clock.advance(1);
    assert.equal(ws.sentOfType('hello').length, 4);

    ws.serverSend(WELCOME);
    await settle();
    await clock.advance(60_000);
    assert.equal(ws.sentOfType('hello').length, 4, 'welcome 이후에는 더 보내지 않는다');
    ws.serverOpen();
    assert.equal(ws.sentOfType('hello').length, 4, 'welcome 이후의 늦은 onOpen 도 무시');
  });

  it('hello 를 다시 보낼 때마다 최신 processedIds 로 만든다', async () => {
    const clock = new FakeClock();
    const sdk = new FakeSdk();
    let n = 0;
    const rig = makeRig(sdk, clock, {
      getHello: (kind) => ({
        type: 'hello',
        clientId: 'client-1',
        pluginName: 'example-test',
        pluginVersion: '1.0.0',
        transport: kind,
        processedIds: [`cmd-${++n}`],
      }),
    });
    const t = new WsTransport(rig.deps);
    rig.start(t);
    await settle();
    await clock.advance(3000);
    const ws = sdk.sockets[0]!;
    assert.deepEqual(
      ws.sentOfType('hello').map((h) => h.processedIds),
      [['cmd-1'], ['cmd-2']],
    );
    await t.stop();
  });

  it('welcome 을 15초 안에 못 받으면 실패한 시도로 보고하고(백오프 포함) 다시 연결한다', async () => {
    const { clock, sdk, ws, rig } = await connected();
    await clock.advance(14_999);
    assert.equal(rig.statuses.length, 0);
    assert.equal(sdk.sockets.length, 1);

    await clock.advance(1); // 15초
    assert.equal(rig.statuses.length, 1);
    assert.equal(rig.statuses[0]!.online, false);
    assert.equal(rig.statuses[0]!.failed, true, '자동 폴백의 실패 횟수에 포함되도록 failed 로 알린다');
    assert.match(rig.statuses[0]!.detail ?? '', /welcome/);
    assert.equal(ws.disconnectCalls, 1, '버리는 소켓의 URL 은 best-effort 로 disconnect');
    assert.equal(ws.sentOfType('hello').length, 5, 't=0,3,6,9,12 에 보냈고 포기한 뒤에는 더 보내지 않는다');
    await clock.advance(1999);
    assert.equal(ws.sentOfType('hello').length, 5);
    assert.equal(sdk.sockets.length, 1, '백오프 2초가 지나기 전에는 새 소켓이 없다');
    await clock.advance(1); // 17초
    assert.equal(sdk.sockets.length, 2);
    assert.notEqual(sdk.sockets[1]!.url, ws.url, '새 시도는 다른 URL');
    assert.equal(sdk.sockets[1]!.sentOfType('hello').length, 1);
  });

  it('welcome 대기 실패의 백오프는 2초, 4초로 늘어난다', async () => {
    const clock = new FakeClock();
    const sdk = new FakeSdk();
    const rig = makeRig(sdk, clock);
    const t = new WsTransport(rig.deps);
    rig.start(t);
    await settle();
    await clock.advance(15_000); // 실패 1 -> 백오프 2초
    assert.equal(sdk.sockets.length, 1);
    await clock.advance(1999);
    assert.equal(sdk.sockets.length, 1);
    await clock.advance(1); // t=17s: 두 번째 시도
    assert.equal(sdk.sockets.length, 2);
    await clock.advance(15_000); // t=32s: 실패 2 -> 백오프 4초
    assert.equal(rig.statuses.filter((s) => s.failed).length, 2);
    await clock.advance(3999);
    assert.equal(sdk.sockets.length, 2);
    await clock.advance(1);
    assert.equal(sdk.sockets.length, 3);
    await t.stop();
  });

  it('welcome 을 받으면 대기 제한과 hello 재전송이 모두 멈춘다(15초가 지나도 재연결하지 않는다)', async () => {
    const { clock, sdk, ws, rig } = await connected();
    await clock.advance(5000);
    ws.serverSend(WELCOME);
    await settle();
    assert.equal(clock.pendingTimers, 1, '남은 타이머는 70초 워치독 하나뿐');
    await clock.advance(20_000);
    assert.equal(sdk.sockets.length, 1);
    assert.equal(rig.statuses.filter((s) => s.failed).length, 0);
    assert.equal(last(rig.statuses).online, true);
  });

  it('소켓이 아직 안 열려 send 가 던져도 잡고, 3초마다/onOpen 에 다시 보내 결국 연결한다', async () => {
    const clock = new FakeClock();
    const sdk = new FakeSdk();
    sdk.newSocketsFailSend = true;
    const rig = makeRig(sdk, clock);
    const t = new WsTransport(rig.deps);
    rig.start(t);
    await settle();
    const ws = sdk.sockets[0]!;
    assert.equal(ws.sent.length, 0);
    assert.ok(rig.logs.some(([lvl, msg]) => lvl === 'warn' && /hello 전송 실패/.test(msg)));
    assert.equal(rig.statuses.length, 0, 'send 오류만으로는 연결 실패로 보지 않는다');

    await clock.advance(3000); // 여전히 던진다
    assert.equal(ws.sent.length, 0);
    assert.equal(sdk.sockets.length, 1);

    ws.failSend = false; // 소켓이 열림
    ws.serverOpen();
    assert.equal(ws.sentOfType('hello').length, 1);
    ws.serverSend(WELCOME);
    await settle();
    assert.equal(last(rig.statuses).online, true);
    await t.stop();
  });

  it('send 가 계속 던지면 15초 뒤에 실패한 시도로 보고하고 다시 연결한다', async () => {
    const clock = new FakeClock();
    const sdk = new FakeSdk();
    sdk.newSocketsFailSend = true;
    const rig = makeRig(sdk, clock);
    const t = new WsTransport(rig.deps);
    rig.start(t);
    await settle();
    await clock.advance(15_000);
    assert.equal(last(rig.statuses).failed, true);
    await clock.advance(2000);
    assert.equal(sdk.sockets.length, 2);
    await t.stop();
  });

  it('401 이 들어 있는 onError(소켓이 열리기 전 연결 거절)도 토큰 안내를 한 번만 알린다', async () => {
    const { ws, rig, clock } = await connected({ token: 'wrong' });
    ws.serverError('WebSocketError', "Unexpected server response: 401");
    ws.serverError('WebSocketError', 'Unexpected server response: 401');
    await settle();
    assert.equal(rig.notifications.length, 1);
    assert.match(rig.notifications[0]![1], /토큰/);
    ws.serverClose();
    await clock.advance(2000);
    assert.equal(rig.notifications.length, 1);
  });
});

// ---------------------------------------------------------------------------
// 시도마다 고유 URL
// ---------------------------------------------------------------------------

describe('WsTransport: 시도마다 고유한 URL', () => {
  it('create 실패/재연결을 포함해 시도마다 ?c={시도번호}-{난수} 가 다르다', async () => {
    const clock = new FakeClock();
    const sdk = new FakeSdk();
    sdk.createPlan = [new Error('x'), new Error('x')];
    const rig = makeRig(sdk, clock);
    const t = new WsTransport(rig.deps);
    rig.start(t);
    await settle();
    await clock.advance(6000); // 3번째 시도 성공
    sdk.sockets[0]!.serverSend(WELCOME);
    await settle();
    sdk.sockets[0]!.serverClose();
    await clock.advance(2000); // 4번째 시도
    const urls = sdk.createRequests.map((r) => r.url);
    assert.equal(urls.length, 4);
    assert.equal(new Set(urls).size, 4);
    urls.forEach((u, i) => {
      assert.match(u, new RegExp(`^ws://host:8765/pos/ws\\?c=${i + 1}-[0-9a-z]{6}$`));
    });
    await t.stop();
  });

  it('기본 주소에 이미 쿼리가 있으면 &c= 로 붙인다', async () => {
    const clock = new FakeClock();
    const sdk = new FakeSdk();
    const rig = makeRig(sdk, clock, { wsUrl: 'ws://host:8765/pos/ws?x=1' });
    const t = new WsTransport(rig.deps);
    rig.start(t);
    await settle();
    assert.match(sdk.createRequests[0]!.url, /^ws:\/\/host:8765\/pos\/ws\?x=1&c=1-[0-9a-z]{6}$/);
    await t.stop();
  });

  it('재연결하면 이전 URL 을 best-effort 로 disconnect 하고, disconnect 가 실패해도 재연결은 막히지 않는다', async () => {
    const { clock, sdk, ws } = await welcomed();
    ws.disconnectError = new Error('websocket is not initialized');
    await clock.advance(70_000); // 워치독
    assert.equal(ws.disconnectCalls, 1);
    await clock.advance(2000);
    assert.equal(sdk.sockets.length, 2, 'disconnect 응답을 기다리지 않고 다시 연결');
    assert.notEqual(sdk.sockets[1]!.url, ws.url);
    assert.equal(sdk.sockets[1]!.disconnectCalls, 0);
  });

  it('stop 도 이전 URL 을 best-effort 로 disconnect 한다(실패해도 stop 은 끝난다)', async () => {
    const { ws, t } = await welcomed();
    ws.disconnectError = new Error('boom');
    await t.stop();
    assert.equal(ws.disconnectCalls, 1);
  });

  it('이전 URL(소켓)의 늦은 이벤트는 새 소켓과 상태에 영향을 주지 않는다', async () => {
    const { clock, sdk, ws: old, rig } = await welcomed();
    old.serverClose();
    await clock.advance(2000);
    const fresh = sdk.sockets[1]!;
    assert.notEqual(fresh.url, old.url);
    const statusCount = rig.statuses.length;
    const helloCount = fresh.sentOfType('hello').length;

    // 호스트가 교체된 URL 의 이벤트를 계속 보내는 경우
    old.serverSend(WELCOME);
    old.serverSend({
      type: 'command',
      command: { id: 'cmd-x', seq: 1, kind: 'CLEAR_CART', createdAt: 't', payload: { scope: 'ours' } },
    });
    old.serverOpen();
    old.serverError('WebSocketError', 'Unexpected server response: 401');
    old.serverClose();
    await settle();
    assert.equal(rig.statuses.length, statusCount, '옛 welcome/close 로 상태가 바뀌면 안 된다');
    assert.equal(fresh.sentOfType('hello').length, helloCount, '옛 onOpen 으로 hello 를 다시 보내면 안 된다');
    assert.equal(rig.messages.filter((m) => m.type === 'command').length, 0);
    assert.equal(rig.notifications.length, 0);
    assert.equal(sdk.sockets.length, 2, '옛 close 로 또 재연결하면 안 된다');

    // 새 소켓은 정상적으로 연결된다
    fresh.serverSend(WELCOME);
    await settle();
    assert.equal(last(rig.statuses).online, true);
    await clock.advance(30_000);
    assert.equal(sdk.sockets.length, 2);
  });
});
