// bridge + 실제 전송 계층(WsTransport / HttpTransport) + 가짜 SDK 를 함께 돌리는 통합 단위 테스트.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createBridge } from '../../src/payment/bridge.ts';
import type { Bridge } from '../../src/payment/bridge.ts';
import type { PluginMessage } from '../../src/payment/protocol.ts';
import type { HttpResponseLike } from '../../src/payment/sdk-types.ts';
import { createTransport } from '../../src/payment/transport.ts';
import { FakeClock, settle } from './fake-clock.ts';
import type { Deferred, HttpRequestRecord } from './fake-sdk.ts';
import { FakeSdk, deferred, jsonResponse } from './fake-sdk.ts';
import { WELCOME } from './transport-helpers.ts';
import { last } from './util.ts';

async function startBridge(transport: 'ws' | 'http', sdk: FakeSdk, clock: FakeClock): Promise<Bridge> {
  sdk.settingValues = {
    serverUrl: 'http://192.168.0.10:8765',
    token: '',
    transport,
    allowStartPayment: true,
    matchCatalog: true,
    showToast: true,
  };
  const bridge = createBridge({
    sdk,
    clock,
    pluginVersion: '1.0.0',
    randomId: () => 'pos-test-client-0001',
    transportFactory: (ctx) =>
      createTransport(ctx.settings.transport, {
        sdk,
        clock,
        wsUrl: ctx.settings.wsUrl,
        httpBase: ctx.settings.serverUrl,
        token: ctx.settings.token,
        clientId: ctx.clientId,
        getHello: ctx.getHello,
        log: ctx.log,
        notify: ctx.notify,
      }),
  });
  sdk.payment.on('paid', (p, o) => {
    void bridge.onPaid(p, o);
  });
  sdk.payment.on('cancel', (p, o) => bridge.onCancel(p, o));
  await bridge.start();
  await settle();
  return bridge;
}

describe('bridge + WsTransport: 결제 메시지는 재연결 후 welcome 마다 다시 나간다', () => {
  it('연결 -> 결제 -> 끊김 -> 재연결 -> welcome 뒤 같은 결제가 새 소켓으로 다시 나간다', async () => {
    const clock = new FakeClock();
    const sdk = new FakeSdk();
    const bridge = await startBridge('ws', sdk, clock);
    const first = sdk.sockets[0]!;
    assert.match(first.url, /^ws:\/\/192\.168\.0\.10:8765\/pos\/ws\?c=1-/);
    assert.equal(first.sentOfType('hello').length, 1);
    first.serverSend(WELCOME);
    await settle();
    assert.equal(bridge.getStatus().online, true);

    sdk.setOrder('ord-1', 0, 5000);
    sdk.emitPaid('pay-1', 'ord-1');
    sdk.emitCancel('pay-0', 'ord-0');
    await settle();
    assert.equal(first.sentOfType('payment.paid').length, 1);
    assert.equal(first.sentOfType('payment.cancelled').length, 1);

    first.serverClose(); // 서버 재시작 등
    await clock.advance(2000);
    const second = sdk.sockets[1]!;
    assert.notEqual(second.url, first.url);
    assert.match(second.url, /\?c=2-/);
    assert.equal(second.sentOfType('payment.paid').length, 0, 'welcome 전에는 보내지 않는다');
    second.serverSend(WELCOME);
    await settle();
    assert.deepEqual(
      second.sent.filter((m) => m.type !== 'hello').map((m) => [m.type, m.paymentId]),
      [
        ['payment.cancelled', 'pay-0'], // 발생 순서(cancel 은 즉시, paid 는 getOrder 를 기다린 뒤)
        ['payment.paid', 'pay-1'],
      ],
    );
    await bridge.stop();
  });

  it('welcome 이 늦어져 15초 안에 못 받아도 결국 재연결해서 welcome 을 받으면 보존된 결제를 보낸다', async () => {
    const clock = new FakeClock();
    const sdk = new FakeSdk();
    const bridge = await startBridge('ws', sdk, clock);
    sdk.sockets[0]!.serverSend(WELCOME);
    await settle();
    sdk.setOrder('ord-1', 0, 5000);
    sdk.emitPaid('pay-1', 'ord-1');
    await settle();

    sdk.sockets[0]!.serverClose();
    await clock.advance(2000);
    // 두 번째 소켓은 서버가 응답하지 않아(hello 유실) 15초 뒤 포기
    await clock.advance(15_000);
    assert.equal(sdk.sockets[1]!.sentOfType('hello').length, 5);
    await clock.advance(4000); // 백오프 4초
    const third = sdk.sockets[2]!;
    third.serverSend(WELCOME);
    await settle();
    assert.equal(third.sentOfType('payment.paid').length, 1);
    assert.equal(bridge.getStatus().online, true);
    await bridge.stop();
  });

  it('bridge 가 만든 hello 가 연결 직후와 3초 뒤에 같은 clientId / transport 로 다시 나간다', async () => {
    const clock = new FakeClock();
    const sdk = new FakeSdk();
    const bridge = await startBridge('ws', sdk, clock);
    const ws = sdk.sockets[0]!;
    await clock.advance(3000);
    const hellos = ws.sentOfType('hello');
    assert.equal(hellos.length, 2);
    assert.equal(hellos[0]!.clientId, 'pos-test-client-0001');
    assert.equal(hellos[0]!.transport, 'ws');
    assert.deepEqual(hellos[0]!.processedIds, []);
    await bridge.stop();
  });
});

describe('bridge + HttpTransport: 결제 메시지는 welcome(재연결) 뒤에 다시 나간다', () => {
  function setupHttp(sdk: FakeSdk) {
    const polls: { req: HttpRequestRecord; d: Deferred<HttpResponseLike> }[] = [];
    const posts: HttpRequestRecord[] = [];
    sdk.httpHandler = (req) => {
      if (req.method === 'GET') {
        const d = deferred<HttpResponseLike>();
        polls.push({ req, d });
        return d.promise;
      }
      posts.push(req);
      // 실제 서버처럼 hello 에만 welcome 으로 답한다.
      const hasHello = (req.payload as { messages: PluginMessage[] }).messages.some((m) => m.type === 'hello');
      return jsonResponse(200, { ok: true, replies: hasHello ? [WELCOME] : [] });
    };
    const postedTypes = (): string[] =>
      posts.flatMap((p) => (p.payload as { messages: PluginMessage[] }).messages.map((m) => m.type));
    return { polls, posts, postedTypes };
  }

  it('hello 응답의 welcome 이 올 때마다 보존된 결제를 다시 POST 한다', async () => {
    const clock = new FakeClock();
    const sdk = new FakeSdk();
    const http = setupHttp(sdk);
    const bridge = await startBridge('http', sdk, clock);
    assert.equal(bridge.getStatus().online, true, 'hello 응답의 welcome 으로 online');
    assert.deepEqual(http.postedTypes(), ['hello']);

    sdk.setOrder('ord-1', 0, 5000);
    sdk.emitPaid('pay-1', 'ord-1');
    await settle();
    assert.deepEqual(http.postedTypes(), ['hello', 'payment.paid']);

    // 폴링이 실패했다가(서버 재시작) 복구되면 hello 를 다시 보내고, 그 welcome 뒤에 결제를 다시 보낸다
    http.polls[0]!.d.reject(new Error('연결 거부'));
    await settle();
    assert.equal(bridge.getStatus().online, false);
    await clock.advance(2000);
    http.polls[1]!.d.resolve(jsonResponse(200, { commands: [] }));
    await settle();
    assert.equal(bridge.getStatus().online, true);
    assert.deepEqual(http.postedTypes(), ['hello', 'payment.paid', 'hello', 'payment.paid']);
    const lastPost = last(http.posts).payload as { messages: PluginMessage[] };
    assert.equal((lastPost.messages[0] as { paymentId: string }).paymentId, 'pay-1');
    await bridge.stop();
  });

  it('폴링이 8초 뒤 네이티브 타임아웃으로 끊겨도 오프라인이 아니므로 결제를 다시 보내지 않는다', async () => {
    const clock = new FakeClock();
    const sdk = new FakeSdk();
    const http = setupHttp(sdk);
    const bridge = await startBridge('http', sdk, clock);
    sdk.setOrder('ord-1', 0, 5000);
    sdk.emitPaid('pay-1', 'ord-1');
    await settle();
    await clock.advance(8000);
    http.polls[0]!.d.reject(new Error('timeout'));
    await settle();
    assert.equal(bridge.getStatus().online, true);
    assert.deepEqual(http.postedTypes(), ['hello', 'payment.paid']);
    assert.match(http.polls[1]!.req.url, /wait=8$/);
    await bridge.stop();
  });
});
