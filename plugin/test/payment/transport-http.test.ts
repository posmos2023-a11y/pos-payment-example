import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Command, PluginMessage } from '../../src/payment/protocol.ts';
import type { HttpResponseLike } from '../../src/payment/sdk-types.ts';
import { HttpTransport } from '../../src/payment/transport.ts';
import { FakeClock, settle } from './fake-clock.ts';
import type { Deferred, HttpRequestRecord } from './fake-sdk.ts';
import { FakeSdk, deferred, jsonResponse } from './fake-sdk.ts';
import { WELCOME, makeRig } from './transport-helpers.ts';
import { last } from './util.ts';

const POLL_URL = 'http://host:8765/pos/poll?clientId=client-1&wait=20';
const EVENTS_URL = 'http://host:8765/pos/events';

interface PendingPoll {
  req: HttpRequestRecord;
  d: Deferred<HttpResponseLike>;
}

/** GET(폴링)은 테스트가 직접 응답할 때까지 대기시키고, POST(events)는 welcome 을 돌려준다. */
function setupServer(sdk: FakeSdk) {
  const polls: PendingPoll[] = [];
  const posts: HttpRequestRecord[] = [];
  const state = { postResponse: (): HttpResponseLike => jsonResponse(200, { ok: true, replies: [WELCOME] }) };
  sdk.httpHandler = (req) => {
    if (req.method === 'GET') {
      const d = deferred<HttpResponseLike>();
      polls.push({ req, d });
      return d.promise;
    }
    posts.push(req);
    return state.postResponse();
  };
  return { polls, posts, state };
}

function cmd(id: string): Command {
  return { id, seq: 1, kind: 'CLEAR_CART', createdAt: 't', payload: { scope: 'ours' } };
}

async function started(opts: { token?: string } = {}) {
  const clock = new FakeClock();
  const sdk = new FakeSdk();
  const server = setupServer(sdk);
  const rig = makeRig(sdk, clock, opts.token ? { token: opts.token } : {});
  const t = new HttpTransport(rig.deps);
  rig.start(t);
  await settle();
  return { clock, sdk, server, rig, t };
}

describe('HttpTransport: 시작', () => {
  it('폴링 요청(GET /pos/poll?clientId&wait=20, timeoutMs 30000)과 hello(POST /pos/events)를 보낸다', async () => {
    const { sdk, server } = await started();
    assert.equal(server.polls.length, 1);
    const poll = server.polls[0]!.req;
    assert.equal(poll.url, POLL_URL);
    assert.deepEqual(poll.options, { timeoutMs: 30_000 });
    assert.deepEqual(poll.headers, [['Content-Type', 'application/json']]);

    assert.equal(server.posts.length, 1);
    const post = server.posts[0]!;
    assert.equal(post.url, EVENTS_URL);
    assert.deepEqual(post.options, { timeoutMs: 30_000 });
    assert.deepEqual(post.headers, [['Content-Type', 'application/json']]);
    assert.deepEqual(post.payload, {
      clientId: 'client-1',
      messages: [
        {
          type: 'hello',
          clientId: 'client-1',
          pluginName: 'example-test',
          pluginVersion: '1.0.0',
          transport: 'http',
          processedIds: ['cmd-1', 'cmd-2'],
        },
      ],
    });
    assert.equal(sdk.requests.length, 2);
  });

  it('토큰이 있으면 Authorization: Bearer 헤더를 붙인다', async () => {
    const { server } = await started({ token: 'tok' });
    const want: [string, string][] = [
      ['Content-Type', 'application/json'],
      ['Authorization', 'Bearer tok'],
    ];
    assert.deepEqual(server.polls[0]!.req.headers, want);
    assert.deepEqual(server.posts[0]!.headers, want);
  });

  it('hello 의 replies 에 온 welcome 으로 online 이 된다', async () => {
    const { rig } = await started();
    assert.deepEqual(rig.statuses, [{ kind: 'http', online: true }]);
    assert.deepEqual(rig.messages, [WELCOME]);
  });
});

describe('HttpTransport: 폴링', () => {
  it('명령을 전달하고, 명령이 있으면 바로 다시 폴링한다', async () => {
    const { server, rig } = await started();
    server.polls[0]!.d.resolve(jsonResponse(200, { commands: [cmd('cmd-5'), cmd('cmd-6')] }));
    await settle();
    const commands = rig.messages.filter((m) => m.type === 'command');
    assert.deepEqual(
      commands.map((m) => (m.type === 'command' ? m.command.id : '')),
      ['cmd-5', 'cmd-6'],
    );
    assert.equal(server.polls.length, 2, '대기 없이 즉시 다음 폴링');
  });

  it('빈 응답이 너무 빨리 오면(서버 이상) 2초 간격을 둔다', async () => {
    const { clock, server } = await started();
    server.polls[0]!.d.resolve(jsonResponse(200, { commands: [] }));
    await settle();
    assert.equal(server.polls.length, 1);
    await clock.advance(1999);
    assert.equal(server.polls.length, 1);
    await clock.advance(1);
    assert.equal(server.polls.length, 2);
  });

  it('깨진 명령 항목은 건너뛴다', async () => {
    const { server, rig } = await started();
    server.polls[0]!.d.resolve(jsonResponse(200, { commands: [{ nope: 1 }, cmd('cmd-7')] }));
    await settle();
    assert.equal(rig.messages.filter((m) => m.type === 'command').length, 1);
  });

  it('401: 토스트(알림) 후 60초 대기', async () => {
    const { clock, server, rig } = await started();
    server.polls[0]!.d.resolve(jsonResponse(401, { error: 'UNAUTHORIZED' }));
    await settle();
    assert.equal(rig.notifications.length, 1);
    assert.equal(rig.notifications[0]![0], 'error');
    assert.match(rig.notifications[0]![1], /토큰/);
    assert.equal(last(rig.statuses).online, false);
    await clock.advance(59_999);
    assert.equal(server.polls.length, 1);
    await clock.advance(1);
    assert.equal(server.polls.length, 2);
    // 또 401: 토스트는 반복해서 띄우지 않는다
    server.polls[1]!.d.resolve(jsonResponse(401, {}));
    await settle();
    assert.equal(rig.notifications.length, 1);
    await clock.advance(60_000);
    assert.equal(server.polls.length, 3);
  });

  it('실패(예외/비정상 응답) 백오프: 2,4,8,16,32,60,60초, 성공하면 초기화', async () => {
    const { clock, server } = await started();
    const delays = [2000, 4000, 8000, 16_000, 32_000, 60_000, 60_000];
    for (let i = 0; i < delays.length; i++) {
      const fail = server.polls[i]!;
      if (i % 2 === 0) fail.d.reject(new Error('네트워크 오류'));
      else fail.d.resolve(jsonResponse(500, 'oops'));
      await settle();
      assert.equal(server.polls.length, i + 1);
      await clock.advance(delays[i]! - 1);
      assert.equal(server.polls.length, i + 1, `${delays[i]}ms 직전`);
      await clock.advance(1);
      assert.equal(server.polls.length, i + 2, `${delays[i]}ms 후 재시도`);
    }
    // 성공하면 실패 횟수가 초기화되어 다음 실패는 다시 2초
    server.polls[7]!.d.resolve(jsonResponse(200, { commands: [cmd('cmd-1')] }));
    await settle();
    assert.equal(server.polls.length, 9);
    server.polls[8]!.d.reject(new Error('다시 실패'));
    await settle();
    await clock.advance(2000);
    assert.equal(server.polls.length, 10);
  });

  it('폴링이 실패하면 offline, 복구되면 hello 를 다시 보낸다', async () => {
    const { clock, server, rig } = await started();
    assert.equal(server.posts.length, 1);
    server.polls[0]!.d.reject(new Error('끊김'));
    await settle();
    assert.equal(last(rig.statuses).online, false);
    await clock.advance(2000);
    server.polls[1]!.d.resolve(jsonResponse(200, { commands: [] }));
    await settle();
    assert.equal(last(rig.statuses).online, true);
    assert.equal(server.posts.length, 2, '복구 후 hello 재전송');
    const second = server.posts[1]!.payload as { messages: PluginMessage[] };
    assert.equal(second.messages[0]!.type, 'hello');
  });
});

describe('HttpTransport: 이벤트 전송', () => {
  it('send 는 즉시 POST /pos/events 로 {clientId, messages} 를 보낸다', async () => {
    const { t, server } = await started();
    const ack: PluginMessage = { type: 'ack', commandId: 'cmd-9', ok: true, draft: null };
    assert.equal(t.send(ack), true);
    await settle();
    assert.equal(server.posts.length, 2);
    assert.deepEqual(server.posts[1]!.payload, { clientId: 'client-1', messages: [ack] });
  });

  it('응답의 replies 를 전달한다', async () => {
    const { t, server, rig } = await started();
    server.state.postResponse = () =>
      jsonResponse(200, {
        ok: true,
        replies: [{ type: 'command', command: cmd('cmd-8') }, { type: 'mystery' }],
      });
    t.send({ type: 'log', level: 'warn', message: 'x' });
    await settle();
    assert.equal(rig.messages.filter((m) => m.type === 'command').length, 1);
  });

  it('실패하면 메시지를 보관했다가 백오프 후 재시도한다(순서 유지)', async () => {
    const { clock, t, server } = await started();
    server.state.postResponse = () => jsonResponse(500, 'down');
    const a1: PluginMessage = { type: 'ack', commandId: 'c1', ok: true, draft: null };
    const a2: PluginMessage = { type: 'ack', commandId: 'c2', ok: true, draft: null };
    t.send(a1);
    await settle();
    t.send(a2);
    await settle();
    assert.equal(server.posts.length, 2, '두 번째 send 는 진행 중인 재시도 루프가 처리한다');
    server.state.postResponse = () => jsonResponse(200, { ok: true, replies: [] });
    await clock.advance(2000);
    const lastBatch = last(server.posts).payload as { messages: PluginMessage[] };
    assert.deepEqual(lastBatch.messages, [a1, a2]);
    // 더 이상 보낼 것이 없으면 요청이 멈춘다
    const n = server.posts.length;
    await clock.advance(120_000);
    assert.equal(server.posts.length, n);
  });

  it('네트워크 예외도 재시도한다', async () => {
    const { clock, sdk, t, server } = await started();
    const real = sdk.httpHandler;
    sdk.httpHandler = (req) => {
      if (req.method === 'POST') throw new Error('네트워크 오류');
      return real(req);
    };
    t.send({ type: 'log', level: 'info', message: 'a' });
    await settle();
    sdk.httpHandler = real;
    await clock.advance(2000);
    assert.equal((last(server.posts).payload as { messages: unknown[] }).messages.length, 1);
  });

  it('보관은 최대 100개: 넘치면 ack/payment.* 를 남기고 나머지부터 버린다', async () => {
    const { clock, t, server } = await started();
    server.state.postResponse = () => jsonResponse(500, 'down');
    t.send({ type: 'log', level: 'info', message: 'first' }); // 첫 실패 루프 시작
    await settle();
    for (let i = 0; i < 30; i++) t.send({ type: 'ack', commandId: `a${i}`, ok: true, draft: null });
    for (let i = 0; i < 120; i++) t.send({ type: 'log', level: 'warn', message: `l${i}` });
    server.state.postResponse = () => jsonResponse(200, { ok: true, replies: [] });
    await clock.advance(2000);
    const lastBatch = last(server.posts).payload as { messages: PluginMessage[] };
    assert.equal(lastBatch.messages.length, 100);
    assert.equal(lastBatch.messages.filter((m) => m.type === 'ack').length, 30);
    assert.equal(lastBatch.messages.filter((m) => m.type === 'log').length, 70);
  });

  it('400 응답은 다시 보내도 소용없으므로 버린다', async () => {
    const { clock, t, server } = await started();
    server.state.postResponse = () => jsonResponse(400, { error: 'bad' });
    t.send({ type: 'log', level: 'info', message: 'x' });
    await settle();
    const n = server.posts.length;
    await clock.advance(10 * 60_000);
    assert.equal(server.posts.length, n);
  });

  it('401 이면 알림 후 60초 뒤 재시도', async () => {
    const { clock, t, server, rig } = await started();
    server.state.postResponse = () => jsonResponse(401, {});
    t.send({ type: 'log', level: 'info', message: 'x' });
    await settle();
    assert.equal(rig.notifications.length, 1);
    const n = server.posts.length;
    server.state.postResponse = () => jsonResponse(200, { ok: true, replies: [] });
    await clock.advance(59_999);
    assert.equal(server.posts.length, n);
    await clock.advance(1);
    assert.equal(server.posts.length, n + 1);
  });
});

describe('HttpTransport: stop', () => {
  it('stop 후에는 더 이상 요청하지 않고, 늦게 도착한 응답은 버린다', async () => {
    const { clock, t, server, rig } = await started();
    await t.stop();
    server.polls[0]!.d.resolve(jsonResponse(200, { commands: [cmd('cmd-5')] }));
    await settle();
    await clock.advance(5 * 60_000);
    assert.equal(server.polls.length, 1);
    assert.equal(rig.messages.some((m) => m.type === 'command'), false);
    assert.equal(t.send({ type: 'log', level: 'info', message: 'x' }), false);
    assert.equal(clock.pendingTimers, 0);
  });

  it('백오프 대기 중에 stop 하면 타이머가 남지 않는다', async () => {
    const { clock, t, server } = await started();
    server.polls[0]!.d.reject(new Error('x'));
    await settle();
    assert.equal(clock.pendingTimers, 1);
    await t.stop();
    assert.equal(clock.pendingTimers, 0);
    await clock.advance(60_000);
    assert.equal(server.polls.length, 1);
  });
});

describe('HttpTransport: 호스트의 네이티브 타임아웃', () => {
  const POLL_URL_8 = 'http://host:8765/pos/poll?clientId=client-1&wait=8';

  it('8초 이상 지난 뒤 실패하면 실패/오프라인/백오프로 치지 않고, wait=8 로 바로 다시 폴링한다', async () => {
    const { clock, server, rig } = await started();
    assert.equal(server.polls[0]!.req.url, POLL_URL, '처음에는 wait=20');
    const statusCount = rig.statuses.length;
    const logCount = rig.logs.length;

    await clock.advance(8000);
    server.polls[0]!.d.reject(new Error('호스트의 HTTP 요청 시간이 초과됐어요'));
    await settle();
    assert.equal(server.polls.length, 2, '백오프 없이 즉시 다시 폴링');
    assert.equal(server.polls[1]!.req.url, POLL_URL_8);
    assert.equal(rig.statuses.length, statusCount, '상태(online)는 그대로');
    assert.equal(last(rig.statuses).online, true);
    assert.equal(server.posts.length, 1, 'offline 이 아니었으니 hello 를 다시 보내지 않는다');
    assert.equal(rig.logs.length, logCount + 1, '대기 시간을 줄였다는 로그 한 줄');

    // 계속 반복해도 실패로 치지 않는다(오프라인/백오프 없음, 로그도 더 늘지 않음)
    for (let i = 1; i <= 3; i++) {
      await clock.advance(9000);
      server.polls[i]!.d.reject(new Error('timeout'));
      await settle();
      assert.equal(server.polls.length, i + 2);
      assert.equal(server.polls[i + 1]!.req.url, POLL_URL_8);
    }
    assert.equal(rig.statuses.length, statusCount);
    assert.equal(rig.logs.length, logCount + 1);
  });

  it('8초 미만에 실패하면 그대로 실패(오프라인 + 백오프)이고 대기 시간도 그대로다', async () => {
    const { clock, server, rig } = await started();
    await clock.advance(7999);
    server.polls[0]!.d.reject(new Error('연결 거부'));
    await settle();
    assert.equal(last(rig.statuses).online, false);
    assert.equal(server.polls.length, 1);
    await clock.advance(2000);
    assert.equal(server.polls.length, 2);
    assert.equal(server.polls[1]!.req.url, POLL_URL, 'wait 는 20 그대로');
  });

  it('wait=8 로 바뀐 뒤에도 정상 응답은 평소처럼 처리하고, 빠른 실패는 백오프한다', async () => {
    const { clock, server, rig } = await started();
    await clock.advance(8000);
    server.polls[0]!.d.reject(new Error('timeout'));
    await settle();
    server.polls[1]!.d.resolve(jsonResponse(200, { commands: [cmd('cmd-31')] }));
    await settle();
    assert.equal(rig.messages.filter((m) => m.type === 'command').length, 1);
    assert.equal(server.polls[2]!.req.url, POLL_URL_8);
    server.polls[2]!.d.reject(new Error('즉시 실패'));
    await settle();
    assert.equal(last(rig.statuses).online, false);
    assert.equal(server.polls.length, 3, '백오프 대기 중');
    await clock.advance(2000);
    assert.equal(server.polls.length, 4);
  });

  it('응답(HTTP 오류 코드)이 8초 뒤에 온 것은 네이티브 타임아웃이 아니라 평소처럼 실패다', async () => {
    const { clock, server, rig } = await started();
    await clock.advance(9000);
    server.polls[0]!.d.resolve(jsonResponse(500, 'oops'));
    await settle();
    assert.equal(last(rig.statuses).online, false);
    assert.equal(server.polls.length, 1);
    await clock.advance(2000);
    assert.equal(server.polls[1]!.req.url, POLL_URL);
  });
});
