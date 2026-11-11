import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { HttpResponseLike } from '../../src/payment/sdk-types.ts';
import { AutoTransport, createTransport, HttpTransport, WsTransport } from '../../src/payment/transport.ts';
import { FakeClock, settle } from './fake-clock.ts';
import type { Deferred, HttpRequestRecord } from './fake-sdk.ts';
import { FakeSdk, deferred, jsonResponse } from './fake-sdk.ts';
import { ACK_MSG, WELCOME, makeRig } from './transport-helpers.ts';
import { last } from './util.ts';

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
    return jsonResponse(200, { ok: true, replies: [WELCOME] });
  };
  return { polls, posts };
}

describe('createTransport', () => {
  it('설정에 맞는 구현을 만든다', () => {
    const rig = makeRig(new FakeSdk(), new FakeClock());
    assert.ok(createTransport('ws', rig.deps) instanceof WsTransport);
    assert.ok(createTransport('http', rig.deps) instanceof HttpTransport);
    assert.ok(createTransport('auto', rig.deps) instanceof AutoTransport);
  });
});

describe('AutoTransport', () => {
  it('WS 로 시작하고, welcome 을 받으면 WS 를 계속 쓴다', async () => {
    const clock = new FakeClock();
    const sdk = new FakeSdk();
    const http = setupHttp(sdk);
    const rig = makeRig(sdk, clock);
    const t = new AutoTransport(rig.deps);
    rig.start(t);
    await settle();
    assert.equal(t.kind, 'ws');
    sdk.sockets[0]!.serverSend(WELCOME);
    await settle();
    assert.deepEqual(rig.statuses, [{ kind: 'ws', online: true }]);
    assert.equal(t.send(ACK_MSG), true);
    assert.deepEqual(last(sdk.sockets[0]!.sent), ACK_MSG);
    assert.equal(http.polls.length, 0);
    await t.stop();
  });

  it('welcome 을 한 번도 못 받은 채 WS 연속 실패 3회 -> HTTP 로 전환', async () => {
    const clock = new FakeClock();
    const sdk = new FakeSdk();
    const http = setupHttp(sdk);
    sdk.createPlan = [new Error('x'), new Error('x'), new Error('x')];
    const rig = makeRig(sdk, clock);
    const t = new AutoTransport(rig.deps);
    rig.start(t);
    await settle(); // 실패 1 (t=0)
    assert.equal(t.kind, 'ws');
    await clock.advance(2000); // 실패 2
    assert.equal(t.kind, 'ws');
    assert.equal(http.polls.length, 0);
    await clock.advance(4000); // 실패 3 -> 전환
    assert.equal(t.kind, 'http');
    assert.equal(sdk.createRequests.length, 3, '더는 WS 연결을 시도하지 않는다');
    assert.equal(http.polls.length, 1, 'HTTP 폴링 시작');
    // hello 의 transport 는 현재 사용 중인 kind
    const hello = (http.posts[0]!.payload as { messages: { type: string; transport: string }[] }).messages[0]!;
    assert.equal(hello.type, 'hello');
    assert.equal(hello.transport, 'http');
    // 상태에도 반영
    assert.equal(rig.statuses.some((s) => s.kind === 'http' && s.online), true);
    await t.stop();
  });

  it('연결은 되지만 welcome 이 오지 않는 시도(15초 대기 초과)도 실패 횟수에 포함되어 3회째에 HTTP 로 전환한다', async () => {
    const clock = new FakeClock();
    const sdk = new FakeSdk();
    const http = setupHttp(sdk);
    const rig = makeRig(sdk, clock);
    const t = new AutoTransport(rig.deps);
    rig.start(t);
    await clock.advance(15_000); // 실패 1
    assert.equal(t.kind, 'ws');
    await clock.advance(2000 + 15_000); // 실패 2
    assert.equal(t.kind, 'ws');
    assert.equal(http.polls.length, 0);
    await clock.advance(4000 + 14_999);
    assert.equal(t.kind, 'ws');
    await clock.advance(1); // t=51s: 실패 3 -> 전환
    assert.equal(t.kind, 'http');
    assert.equal(sdk.sockets.length, 3);
    assert.equal(http.polls.length, 1);
    await t.stop();
  });

  it('HTTP 로 전환한 뒤에는 send 가 HTTP 로 나간다', async () => {
    const clock = new FakeClock();
    const sdk = new FakeSdk();
    const http = setupHttp(sdk);
    sdk.createPlan = [new Error('x'), new Error('x'), new Error('x')];
    const rig = makeRig(sdk, clock);
    const t = new AutoTransport(rig.deps);
    rig.start(t);
    await clock.advance(6000);
    assert.equal(t.kind, 'http');
    const before = http.posts.length;
    assert.equal(t.send(ACK_MSG), true);
    await settle();
    assert.equal(http.posts.length, before + 1);
    assert.deepEqual((last(http.posts).payload as { messages: unknown[] }).messages, [ACK_MSG]);
    await t.stop();
  });

  it('10분 뒤 WS 를 다시 시도하고, 성공하면 WS 로 돌아온다(HTTP 는 중단)', async () => {
    const clock = new FakeClock();
    const sdk = new FakeSdk();
    const http = setupHttp(sdk);
    sdk.createPlan = [new Error('x'), new Error('x'), new Error('x')];
    const rig = makeRig(sdk, clock);
    const t = new AutoTransport(rig.deps);
    rig.start(t);
    await clock.advance(6000);
    assert.equal(t.kind, 'http');
    await clock.advance(10 * 60_000 - 1);
    assert.equal(sdk.createRequests.length, 3);
    await clock.advance(1);
    assert.equal(sdk.createRequests.length, 4, '10분 뒤 WS 재시도');
    assert.equal(t.kind, 'ws');
    sdk.sockets[0]!.serverSend(WELCOME);
    await settle();
    assert.equal(last(rig.statuses).kind, 'ws');
    assert.equal(last(rig.statuses).online, true);
    // 이전 HTTP 폴링은 정리됨: 대기 중이던 폴링에 응답해도 더 요청하지 않는다
    const pollsBefore = http.polls.length;
    last(http.polls).d.resolve(jsonResponse(200, { commands: [] }));
    await clock.advance(60_000);
    assert.equal(http.polls.length, pollsBefore);
    await t.stop();
  });

  it('WS 재시도도 3번 실패하면 다시 HTTP 로 돌아가고 10분 뒤 또 시도한다', async () => {
    const clock = new FakeClock();
    const sdk = new FakeSdk();
    const http = setupHttp(sdk);
    sdk.createPlan = Array.from({ length: 6 }, () => new Error('x'));
    const rig = makeRig(sdk, clock);
    const t = new AutoTransport(rig.deps);
    rig.start(t);
    await clock.advance(6000);
    assert.equal(t.kind, 'http');
    await clock.advance(10 * 60_000); // WS 재시도 시작 (실패 1)
    assert.equal(t.kind, 'ws');
    await clock.advance(2000 + 4000); // 실패 2, 3
    assert.equal(t.kind, 'http');
    assert.equal(sdk.createRequests.length, 6);
    assert.ok(http.polls.length >= 2);
    await t.stop();
  });

  it('WS 로 한 번이라도 연결된 뒤의 끊김/실패는 HTTP 로 전환하지 않는다', async () => {
    const clock = new FakeClock();
    const sdk = new FakeSdk();
    const http = setupHttp(sdk);
    const rig = makeRig(sdk, clock);
    const t = new AutoTransport(rig.deps);
    rig.start(t);
    await settle();
    sdk.sockets[0]!.serverSend(WELCOME);
    await settle();
    sdk.createPlan = Array.from({ length: 6 }, () => new Error('서버 꺼짐'));
    sdk.sockets[0]!.serverClose();
    await clock.advance(2000 + 4000 + 8000 + 16_000 + 32_000 + 60_000);
    assert.equal(t.kind, 'ws');
    assert.ok(sdk.createRequests.length >= 6);
    assert.equal(http.polls.length, 0);
    await t.stop();
  });

  it('WS 실패 중 welcome 이 한 번 오면 연속 실패 횟수가 초기화된다', async () => {
    const clock = new FakeClock();
    const sdk = new FakeSdk();
    const http = setupHttp(sdk);
    sdk.createPlan = [new Error('x'), new Error('x')];
    const rig = makeRig(sdk, clock);
    const t = new AutoTransport(rig.deps);
    rig.start(t);
    await clock.advance(6000); // 실패 2번 뒤 세 번째 연결 성공
    sdk.sockets[0]!.serverSend(WELCOME);
    await settle();
    assert.equal(t.kind, 'ws');
    assert.equal(http.polls.length, 0);
    await t.stop();
  });

  it('stop 하면 자식 전송 계층을 정리하고 타이머를 남기지 않는다', async () => {
    const clock = new FakeClock();
    const sdk = new FakeSdk();
    setupHttp(sdk);
    sdk.createPlan = [new Error('x'), new Error('x'), new Error('x')];
    const rig = makeRig(sdk, clock);
    const t = new AutoTransport(rig.deps);
    rig.start(t);
    await clock.advance(6000);
    assert.equal(t.kind, 'http');
    await t.stop();
    assert.equal(clock.pendingTimers, 0);
    assert.equal(t.send(ACK_MSG), false);
  });
});
