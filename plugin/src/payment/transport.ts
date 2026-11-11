// 전송 계층: WebSocket / HTTP 롱폴링 / 자동(WS 우선).
// SDK 0.0.31 실제 코드에서 확인된 사실을 지킨다.
//  - websocket.create() 는 내부에서 이미 connect() 를 호출한다 -> connect() 를 다시 부르지 않는다.
//  - 토스 공식 에뮬레이터는 소켓이 열리기 *전에* connect 응답(complete:true)을 돌려준다. 그래서 create() 가 끝나도
//    소켓이 아직 안 열렸을 수 있고, 그때 보낸 hello 는 유실된다 -> hello 는 create 직후 + onOpen + welcome 을 받을 때까지
//    3초마다 다시 보내고, 15초 안에 welcome 이 없으면 실패한 시도로 보고 다시 연결한다.
//  - SDK 는 websocket 이벤트를 URL 로만 라우팅하고 호스트는 교체/종료된 소켓의 이벤트도 계속 보낼 수 있다
//    -> 시도마다 고유한 URL(`?c={시도번호}-{난수}`)을 쓰고 이전 URL 은 best-effort 로 disconnect 한다.
//    (예전에는 같은 URL 의 새 소켓이 끊길까 봐 close 로 이미 끊긴 소켓에는 disconnect 를 부르지 않았다. 이제 URL 이
//     고유해서 그럴 염려가 없으므로, 호스트의 소켓 목록을 치우도록 끊긴 소켓에도 한 번 부른다.)
import type { Clock } from './clock.ts';
import { Sleeper } from './clock.ts';
import type {
  Command,
  HelloMessage,
  LogLevel,
  PluginMessage,
  ServerMessage,
  TransportKind,
} from './protocol.ts';
import {
  coerceCommand,
  coerceServerMessage,
  enqueueOutgoing,
  parseServerMessage,
  trimOutgoing,
} from './protocol.ts';
import type { SdkLike, WebsocketLike } from './sdk-types.ts';

export type { LogLevel, TransportKind };

export const WS_CONNECT_TIMEOUT_MS = 5000;
export const WS_WATCHDOG_MS = 70_000;
/** hello 를 welcome 을 받을 때까지 이 간격으로 다시 보낸다. */
export const WS_HELLO_RETRY_MS = 3000;
/** create 후 welcome 을 이 시간 안에 못 받으면 실패한 시도로 본다. */
export const WS_WELCOME_TIMEOUT_MS = 15_000;
export const HTTP_POLL_WAIT_SEC = 20;
/** 롱폴이 이 시간 이상 지난 뒤 실패하면 호스트의 네이티브 타임아웃으로 본다. */
export const HTTP_NATIVE_TIMEOUT_MIN_MS = 8000;
/** 네이티브 타임아웃이 관측된 뒤의 롱폴 대기 시간(초). */
export const HTTP_POLL_WAIT_SHORT_SEC = 8;
export const HTTP_TIMEOUT_MS = 30_000;
export const AUTH_BLOCK_MS = 60_000;
export const AUTH_TOAST_INTERVAL_MS = 10 * 60_000;
export const HTTP_QUEUE_MAX = 100;
/** 빈 응답이 이 시간보다 빨리 오면(서버 이상) 폴링이 폭주하지 않도록 최소 간격을 둔다. */
export const MIN_EMPTY_POLL_MS = 2000;
export const AUTO_FAILURES_TO_HTTP = 3;
export const AUTO_RETRY_WS_MS = 10 * 60_000;
export const BACKOFF_MS = [2000, 4000, 8000, 16_000, 32_000, 60_000];

/** 연속 실패 횟수(1부터) -> 대기 시간. 2,4,8,16,32,60,60,... */
export function backoffDelay(failures: number): number {
  const i = Math.min(Math.max(failures, 1), BACKOFF_MS.length) - 1;
  return BACKOFF_MS[i]!;
}

export interface TransportStatus {
  kind: TransportKind;
  online: boolean;
  /** 연결 실패/끊김을 알리는 상태일 때 true (AutoTransport 가 연속 실패 횟수를 센다) */
  failed?: boolean;
  detail?: string;
}

export interface TransportHandlers {
  onMessage(msg: ServerMessage): void;
  onStatus(status: TransportStatus): void;
}

export interface Transport {
  readonly kind: TransportKind;
  start(handlers: TransportHandlers): void;
  /**
   * 메시지를 보낸다. 전송 계층이 "받아 갔으면"(소켓에 썼거나 내부 큐에 넣었으면) true,
   * 지금 보낼 수 없으면 false(호출한 bridge 가 자체 버퍼에 보관한다).
   */
  send(msg: PluginMessage): boolean;
  stop(): Promise<void>;
}

export interface TransportDeps {
  sdk: Pick<SdkLike, 'websocket' | 'http'>;
  clock: Clock;
  wsUrl: string;
  /** 정규화된 http(s) 주소(끝 '/' 없음) */
  httpBase: string;
  token: string;
  clientId: string;
  /** hello 메시지 생성(processedIds 등은 bridge 가 채운다) */
  getHello(kind: TransportKind): HelloMessage;
  log(level: LogLevel, message: string): void;
  /** 사용자에게 보여줄 설정/인증 문제 알림 */
  notify(level: 'warn' | 'error', message: string): void;
}

export function buildHeaders(token: string): [string, string][] {
  const headers: [string, string][] = [['Content-Type', 'application/json']];
  if (token) headers.push(['Authorization', `Bearer ${token}`]);
  return headers;
}

function errText(e: unknown): string {
  if (e instanceof Error) return e.message || e.name;
  if (typeof e === 'string') return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

const AUTH_MESSAGE = '매장 토큰이 맞지 않아요. [설정] 탭에서 매장 토큰을 확인해 주세요';

/** WebSocket 연결 실패 메시지가 인증 거절(HTTP 401)로 보이는지 */
export function looksUnauthorized(text: string): boolean {
  return /\b401\b|unauthori[sz]ed/i.test(text);
}

function randomToken(): string {
  let s = '';
  for (let i = 0; i < 6; i++) s += Math.floor(Math.random() * 36).toString(36);
  return s;
}

/** 시도마다 고유한 WebSocket URL. SDK/호스트가 이벤트를 URL 로만 구분하므로 시도 사이에 URL 이 겹치지 않게 한다. */
export function uniqueWsUrl(base: string, attempt: number): string {
  return `${base}${base.includes('?') ? '&' : '?'}c=${attempt}-${randomToken()}`;
}

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------

export class WsTransport implements Transport {
  readonly kind = 'ws' as const;
  private readonly deps: TransportDeps;
  private handlers: TransportHandlers | null = null;
  private ws: WebsocketLike | null = null;
  /** 소켓이 아직 열려 있다고 "믿는" 상태. close 이벤트를 받으면 false. */
  private wsOpen = false;
  private online = false;
  private stopped = true;
  /** 소켓 세대. 이전 소켓의 늦은 콜백을 무시하기 위해 쓴다. */
  private gen = 0;
  private failures = 0;
  private connecting: Promise<void> | null = null;
  private reconnectTimer: unknown = null;
  private watchdogTimer: unknown = null;
  /** welcome 대기 제한(15초) 타이머 */
  private welcomeTimer: unknown = null;
  /** hello 재전송(3초) 타이머 */
  private helloTimer: unknown = null;
  /** 연결 시도 번호(고유 URL 용). 인스턴스 수명 동안 계속 증가한다. */
  private attempt = 0;
  private lastAuthToastAt = Number.NEGATIVE_INFINITY;

  constructor(deps: TransportDeps) {
    this.deps = deps;
  }

  start(handlers: TransportHandlers): void {
    this.handlers = handlers;
    this.stopped = false;
    this.failures = 0;
    this.connecting = this.connectOnce();
  }

  send(msg: PluginMessage): boolean {
    if (!this.online || !this.ws || !this.wsOpen) return false;
    try {
      this.ws.send({ data: JSON.stringify(msg) });
      return true;
    } catch (e) {
      this.deps.log('warn', `WebSocket 전송 실패: ${errText(e)}`);
      return false;
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.clearReconnect();
    this.clearTimers();
    this.gen++;
    if (this.connecting) {
      try {
        await this.connecting;
      } catch {
        // connectOnce 는 던지지 않지만 방어
      }
    }
    const ws = this.ws;
    this.ws = null;
    this.wsOpen = false;
    this.online = false;
    // 시도마다 URL 이 달라서 다음 연결과 겹치지 않으므로 응답을 기다리지 않는다(best-effort).
    if (ws) this.disconnectQuietly(ws);
  }

  // ---- 내부 -----------------------------------------------------------

  private async connectOnce(): Promise<void> {
    if (this.stopped) return;
    const { sdk, wsUrl, token } = this.deps;
    const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
    const url = uniqueWsUrl(wsUrl, ++this.attempt);
    let ws: WebsocketLike;
    try {
      // create() 가 내부에서 connect() 까지 수행한다. 여기서 ws.connect() 를 또 부르면 안 된다.
      ws = await sdk.websocket.create(url, headers, { timeout: WS_CONNECT_TIMEOUT_MS });
    } catch (e) {
      if (this.stopped) return;
      this.failures++;
      const text = errText(e);
      this.deps.log('warn', `WebSocket 연결 실패: ${text}`);
      // 서버는 토큰이 틀리면 업그레이드 전에 HTTP 401 로 거절한다 -> create() 실패로 나타난다.
      if (looksUnauthorized(text)) this.notifyAuth();
      this.emit({ kind: 'ws', online: false, failed: true, detail: text });
      this.scheduleReconnect();
      return;
    }
    const gen = ++this.gen;
    this.ws = ws;
    this.wsOpen = true;
    // stop() 이 연결 중에 호출됐다면 stop() 이 이 소켓을 정리한다.
    if (this.stopped) return;

    ws.onMessage((raw) => this.onRawMessage(gen, raw));
    ws.onClose((code) => this.onClose(gen, code));
    ws.onError((name, message) => this.onError(gen, name, message));
    ws.onOpen(() => this.onOpen(gen));

    this.armWatchdog(gen);
    this.armWelcomeTimeout(gen);
    this.sendHello(gen);
  }

  /**
   * hello 를 보내고 3초 뒤에 다시 보내도록 타이머를 건다(welcome 을 받으면 멈춘다).
   * 소켓이 아직 안 열렸다면 이번 hello 는 유실될 수 있고, ws.send 가 던져도 여기서 잡는다.
   */
  private sendHello(gen: number): void {
    if (gen !== this.gen || this.stopped || this.online || !this.ws) return;
    this.clearHelloTimer();
    try {
      this.ws.send({ data: JSON.stringify(this.deps.getHello('ws')) });
    } catch (e) {
      this.deps.log('warn', `hello 전송 실패(곧 다시 보내요): ${errText(e)}`);
    }
    this.helloTimer = this.deps.clock.setTimeout(() => {
      this.helloTimer = null;
      this.sendHello(gen);
    }, WS_HELLO_RETRY_MS);
  }

  private onOpen(gen: number): void {
    if (gen !== this.gen || this.stopped || this.online) return;
    // 호스트가 소켓을 연 뒤에야 hello 가 실제로 나갈 수 있다.
    this.sendHello(gen);
  }

  private onRawMessage(gen: number, raw: string): void {
    if (gen !== this.gen || this.stopped) return;
    this.armWatchdog(gen);
    const msg = parseServerMessage(raw);
    if (!msg) {
      this.deps.log('warn', '알 수 없는 서버 메시지를 무시해요');
      return;
    }
    if (msg.type === 'ping') {
      this.sendRaw({ type: 'pong', t: msg.t });
      return;
    }
    if (msg.type === 'welcome') {
      this.failures = 0;
      this.clearWelcomeTimer();
      this.clearHelloTimer();
      if (!this.online) {
        this.online = true;
        this.emit({ kind: 'ws', online: true });
      }
    }
    this.deliver(msg);
  }

  private onClose(gen: number, code: string): void {
    if (gen !== this.gen || this.stopped) return;
    // close 이벤트로 이미 끊겼으므로 disconnect() 는 부르지 않는다.
    this.wsOpen = false;
    this.handleLost(gen, `연결이 닫혔어요(${code})`);
  }

  private onError(gen: number, name?: string, message?: string): void {
    if (gen !== this.gen || this.stopped) return;
    // 오류만으로는 소켓 상태를 단정할 수 없다. close 이벤트, welcome 15초 제한, 70초 워치독이 정리한다.
    const text = `${name ?? ''} ${message ?? ''}`.trim();
    this.deps.log('warn', `WebSocket 오류: ${text}`);
    // 에뮬레이터처럼 connect 응답이 소켓이 열리기 전에 오는 호스트에서는 토큰 거절(401)이 create 실패가 아니라 여기로 온다.
    if (looksUnauthorized(text)) this.notifyAuth();
  }

  private handleLost(gen: number, reason: string): void {
    if (gen !== this.gen || this.stopped) return;
    this.gen++; // 이 소켓의 이후 콜백은 모두 무시
    this.clearTimers();
    const ws = this.ws;
    this.ws = null;
    this.wsOpen = false;
    this.online = false;
    this.failures++;
    this.deps.log('warn', `WebSocket 연결 끊김: ${reason}`);
    this.emit({ kind: 'ws', online: false, failed: true, detail: reason });
    // 이전 URL 은 best-effort 로 정리한다(close 이벤트로 이미 끊긴 소켓도: 호스트의 소켓 목록에서 치워 준다).
    // 다음 시도는 다른 URL 이라 같은 URL 의 새 소켓이 끊길 염려가 없고, 응답을 기다릴 필요도 없다.
    if (ws) this.disconnectQuietly(ws);
    this.scheduleReconnect();
  }

  private disconnectQuietly(ws: WebsocketLike): void {
    try {
      Promise.resolve(ws.disconnect()).catch((e: unknown) => {
        this.deps.log('warn', `WebSocket 종료 중 오류: ${errText(e)}`);
      });
    } catch (e) {
      this.deps.log('warn', `WebSocket 종료 중 오류: ${errText(e)}`);
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer !== null) return;
    const delay = backoffDelay(this.failures);
    this.reconnectTimer = this.deps.clock.setTimeout(() => {
      this.reconnectTimer = null;
      if (this.stopped) return;
      this.connecting = this.connectOnce();
    }, delay);
  }

  private armWatchdog(gen: number): void {
    this.clearWatchdog();
    this.watchdogTimer = this.deps.clock.setTimeout(() => {
      this.watchdogTimer = null;
      if (gen !== this.gen || this.stopped) return;
      this.handleLost(gen, '서버 메시지가 70초 동안 없어요');
    }, WS_WATCHDOG_MS);
  }

  private armWelcomeTimeout(gen: number): void {
    this.clearWelcomeTimer();
    this.welcomeTimer = this.deps.clock.setTimeout(() => {
      this.welcomeTimer = null;
      if (gen !== this.gen || this.stopped || this.online) return;
      this.handleLost(gen, `welcome 을 ${WS_WELCOME_TIMEOUT_MS / 1000}초 안에 받지 못했어요`);
    }, WS_WELCOME_TIMEOUT_MS);
  }

  private clearWatchdog(): void {
    if (this.watchdogTimer !== null) {
      this.deps.clock.clearTimeout(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  private clearWelcomeTimer(): void {
    if (this.welcomeTimer !== null) {
      this.deps.clock.clearTimeout(this.welcomeTimer);
      this.welcomeTimer = null;
    }
  }

  private clearHelloTimer(): void {
    if (this.helloTimer !== null) {
      this.deps.clock.clearTimeout(this.helloTimer);
      this.helloTimer = null;
    }
  }

  private clearTimers(): void {
    this.clearWatchdog();
    this.clearWelcomeTimer();
    this.clearHelloTimer();
  }

  private clearReconnect(): void {
    if (this.reconnectTimer !== null) {
      this.deps.clock.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private notifyAuth(): void {
    const now = this.deps.clock.now();
    if (now - this.lastAuthToastAt >= AUTH_TOAST_INTERVAL_MS) {
      this.lastAuthToastAt = now;
      this.deps.notify('error', AUTH_MESSAGE);
    }
  }

  private sendRaw(msg: PluginMessage): void {
    if (!this.ws || !this.wsOpen) return;
    try {
      this.ws.send({ data: JSON.stringify(msg) });
    } catch (e) {
      this.deps.log('warn', `WebSocket 전송 실패: ${errText(e)}`);
    }
  }

  private deliver(msg: ServerMessage): void {
    try {
      this.handlers?.onMessage(msg);
    } catch (e) {
      this.deps.log('error', `메시지 처리 중 오류: ${errText(e)}`);
    }
  }

  private emit(status: TransportStatus): void {
    try {
      this.handlers?.onStatus(status);
    } catch (e) {
      this.deps.log('error', `상태 처리 중 오류: ${errText(e)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// HTTP 롱폴링
// ---------------------------------------------------------------------------

export class HttpTransport implements Transport {
  readonly kind = 'http' as const;
  private readonly deps: TransportDeps;
  private readonly sleeper: Sleeper;
  private handlers: TransportHandlers | null = null;
  private stopped = true;
  /** start()/stop() 마다 증가. 이전 세션의 늦은 응답을 버리기 위해 쓴다. */
  private session = 0;
  private online = false;
  private helloPending = true;
  private queue: PluginMessage[] = [];
  private flushing = false;
  private lastAuthToastAt = Number.NEGATIVE_INFINITY;
  /** 롱폴 대기 시간(초). 네이티브 타임아웃이 관측되면 8초로 낮춘다. */
  private pollWaitSec = HTTP_POLL_WAIT_SEC;

  constructor(deps: TransportDeps) {
    this.deps = deps;
    this.sleeper = new Sleeper(deps.clock);
  }

  start(handlers: TransportHandlers): void {
    this.handlers = handlers;
    this.stopped = false;
    this.session++;
    this.helloPending = true;
    this.online = false;
    void this.pollLoop(this.session);
    void this.flush();
  }

  send(msg: PluginMessage): boolean {
    if (this.stopped) return false;
    enqueueOutgoing(this.queue, msg, HTTP_QUEUE_MAX);
    void this.flush();
    return true;
  }

  stop(): Promise<void> {
    this.stopped = true;
    this.session++;
    this.online = false;
    this.sleeper.cancelAll();
    // 진행 중인 요청은 취소할 수 없다. 끝나도 session 이 달라서 결과는 버려진다.
    return Promise.resolve();
  }

  // ---- 내부 -----------------------------------------------------------

  private active(session: number): boolean {
    return !this.stopped && session === this.session;
  }

  private pollUrl(): string {
    return (
      `${this.deps.httpBase}/pos/poll?clientId=${encodeURIComponent(this.deps.clientId)}` +
      `&wait=${this.pollWaitSec}`
    );
  }

  private async pollLoop(session: number): Promise<void> {
    const { sdk, clock } = this.deps;
    let failures = 0;
    while (this.active(session)) {
      const startedAt = clock.now();
      let delay = 0;
      try {
        const res = await sdk.http.get(this.pollUrl(), buildHeaders(this.deps.token), {
          timeoutMs: HTTP_TIMEOUT_MS,
        });
        if (!this.active(session)) return;
        if (res.code === 200) {
          const commands = parsePollBody(res.body);
          failures = 0;
          this.setOnline(true);
          for (const command of commands) this.deliver({ type: 'command', command });
          if (commands.length === 0) {
            const elapsed = clock.now() - startedAt;
            if (elapsed < MIN_EMPTY_POLL_MS) delay = MIN_EMPTY_POLL_MS - elapsed;
          }
        } else if (res.code === 401) {
          this.setOnline(false);
          this.notifyAuth();
          delay = AUTH_BLOCK_MS;
        } else {
          failures++;
          this.setOnline(false);
          this.deps.log('warn', `폴링 응답 오류: HTTP ${res.code}`);
          delay = backoffDelay(failures);
        }
      } catch (e) {
        if (!this.active(session)) return;
        if (clock.now() - startedAt >= HTTP_NATIVE_TIMEOUT_MIN_MS) {
          // 서버가 죽은 게 아니라 호스트(네이티브)의 요청 제한 시간이 우리 롱폴 대기보다 짧은 것으로 본다.
          // 실패/오프라인/백오프로 치지 않고 다음부터는 대기 시간을 줄여서 요청한다.
          if (this.pollWaitSec !== HTTP_POLL_WAIT_SHORT_SEC) {
            this.pollWaitSec = HTTP_POLL_WAIT_SHORT_SEC;
            this.deps.log(
              'warn',
              `롱폴이 ${Math.round((clock.now() - startedAt) / 1000)}초 만에 끊겼어요(${errText(e)}); 대기 시간을 ${HTTP_POLL_WAIT_SHORT_SEC}초로 줄여요`,
            );
          }
        } else {
          failures++;
          this.setOnline(false);
          this.deps.log('warn', `폴링 실패: ${errText(e)}`);
          delay = backoffDelay(failures);
        }
      }
      if (delay > 0) await this.sleeper.sleep(delay);
    }
  }

  /** 단일 비행(single-flight) 전송 루프. 실패하면 메시지를 되돌려 놓고 백오프 후 재시도한다. */
  private async flush(): Promise<void> {
    if (this.flushing || this.stopped) return;
    this.flushing = true;
    const session = this.session;
    const { sdk } = this.deps;
    let failures = 0;
    try {
      while (this.active(session) && (this.helloPending || this.queue.length > 0)) {
        const includeHello = this.helloPending;
        const batch = this.queue.splice(0, this.queue.length);
        const messages: PluginMessage[] = includeHello
          ? [this.deps.getHello('http'), ...batch]
          : batch;
        let delay = 0;
        try {
          const res = await sdk.http.post(
            `${this.deps.httpBase}/pos/events`,
            { clientId: this.deps.clientId, messages },
            buildHeaders(this.deps.token),
            { timeoutMs: HTTP_TIMEOUT_MS },
          );
          if (!this.active(session)) return;
          if (res.code >= 200 && res.code < 300) {
            failures = 0;
            if (includeHello) this.helloPending = false;
            this.handleReplies(res.body);
          } else if (res.code === 401) {
            this.requeue(batch);
            this.notifyAuth();
            delay = AUTH_BLOCK_MS;
          } else if (res.code === 400 || res.code === 413 || res.code === 422) {
            // 다시 보내도 소용없는 요청: 버리고 넘어간다(무한 재시도 방지).
            this.deps.log('warn', `서버가 이벤트를 거부했어요(HTTP ${res.code}); ${messages.length}개를 버려요`);
            if (includeHello) this.helloPending = false;
          } else {
            failures++;
            this.requeue(batch);
            this.deps.log('warn', `이벤트 전송 오류: HTTP ${res.code}`);
            delay = backoffDelay(failures);
          }
        } catch (e) {
          if (!this.active(session)) return;
          failures++;
          this.requeue(batch);
          this.deps.log('warn', `이벤트 전송 실패: ${errText(e)}`);
          delay = backoffDelay(failures);
        }
        if (delay > 0) await this.sleeper.sleep(delay);
      }
    } finally {
      this.flushing = false;
    }
  }

  private requeue(batch: PluginMessage[]): void {
    this.queue.unshift(...batch);
    trimOutgoing(this.queue, HTTP_QUEUE_MAX);
  }

  private handleReplies(body: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return;
    }
    const replies = (parsed as { replies?: unknown } | null)?.replies;
    if (!Array.isArray(replies)) return;
    for (const r of replies as unknown[]) {
      const msg = coerceServerMessage(r);
      if (!msg) continue;
      if (msg.type === 'welcome') this.setOnline(true);
      this.deliver(msg);
    }
  }

  private setOnline(online: boolean): void {
    if (online === this.online) return;
    this.online = online;
    if (!online) {
      // 연결이 복구되면 hello 를 다시 보내 processedIds 등을 갱신한다.
      this.helloPending = true;
    }
    this.emit({ kind: 'http', online });
    if (online) void this.flush();
  }

  private notifyAuth(): void {
    const now = this.deps.clock.now();
    if (now - this.lastAuthToastAt >= AUTH_TOAST_INTERVAL_MS) {
      this.lastAuthToastAt = now;
      this.deps.notify('error', AUTH_MESSAGE);
    }
    this.deps.log('warn', '서버가 매장 토큰을 거부했어요(401); 60초 후 다시 시도해요');
  }

  private deliver(msg: ServerMessage): void {
    try {
      this.handlers?.onMessage(msg);
    } catch (e) {
      this.deps.log('error', `메시지 처리 중 오류: ${errText(e)}`);
    }
  }

  private emit(status: TransportStatus): void {
    try {
      this.handlers?.onStatus(status);
    } catch (e) {
      this.deps.log('error', `상태 처리 중 오류: ${errText(e)}`);
    }
  }
}

function parsePollBody(body: string): Command[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }
  const list = (parsed as { commands?: unknown } | null)?.commands;
  if (!Array.isArray(list)) return [];
  const out: Command[] = [];
  for (const raw of list as unknown[]) {
    const c = coerceCommand(raw);
    if (c) out.push(c);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 자동: WS 우선, 실패하면 HTTP
// ---------------------------------------------------------------------------

export class AutoTransport implements Transport {
  private readonly deps: TransportDeps;
  private handlers: TransportHandlers | null = null;
  private child: Transport | null = null;
  private currentKind: TransportKind = 'ws';
  private stopped = true;
  private everWelcomed = false;
  private wsFailures = 0;
  private switching = false;
  private retryTimer: unknown = null;

  constructor(deps: TransportDeps) {
    this.deps = deps;
  }

  get kind(): TransportKind {
    return this.child ? this.child.kind : this.currentKind;
  }

  start(handlers: TransportHandlers): void {
    this.handlers = handlers;
    this.stopped = false;
    this.startWs();
  }

  send(msg: PluginMessage): boolean {
    return this.child ? this.child.send(msg) : false;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.retryTimer !== null) {
      this.deps.clock.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    const child = this.child;
    this.child = null;
    if (child) await child.stop();
  }

  // ---- 내부 -----------------------------------------------------------

  private startWs(): void {
    const child = new WsTransport(this.deps);
    this.child = child;
    this.currentKind = 'ws';
    this.everWelcomed = false;
    this.wsFailures = 0;
    child.start(this.wrap(child));
  }

  private wrap(child: Transport): TransportHandlers {
    return {
      onMessage: (msg) => {
        if (this.child === child) this.handlers?.onMessage(msg);
      },
      onStatus: (status) => this.onChildStatus(child, status),
    };
  }

  private onChildStatus(child: Transport, status: TransportStatus): void {
    if (this.stopped || this.child !== child) return;
    if (status.kind === 'ws') {
      if (status.online) {
        this.everWelcomed = true;
        this.wsFailures = 0;
      } else if (status.failed) {
        this.wsFailures++;
      }
    }
    this.handlers?.onStatus(status);
    if (
      status.kind === 'ws' &&
      status.failed &&
      !this.everWelcomed &&
      this.wsFailures >= AUTO_FAILURES_TO_HTTP
    ) {
      void this.switchToHttp();
    }
  }

  private async switchToHttp(): Promise<void> {
    if (this.switching || this.stopped) return;
    this.switching = true;
    try {
      const old = this.child;
      this.child = null;
      this.currentKind = 'http';
      if (old) await old.stop();
      if (this.stopped) return;
      this.deps.log('warn', 'WebSocket 연결이 계속 실패해서 HTTP 폴링으로 전환해요');
      const http = new HttpTransport(this.deps);
      this.child = http;
      http.start(this.wrap(http));
      this.handlers?.onStatus({ kind: 'http', online: false, detail: 'WebSocket 대신 HTTP 폴링 사용' });
      this.retryTimer = this.deps.clock.setTimeout(() => {
        this.retryTimer = null;
        void this.retryWs();
      }, AUTO_RETRY_WS_MS);
    } finally {
      this.switching = false;
    }
  }

  private async retryWs(): Promise<void> {
    if (this.stopped || this.switching) return;
    this.switching = true;
    try {
      const old = this.child;
      this.child = null;
      if (old) await old.stop();
      if (this.stopped) return;
      this.deps.log('info', 'WebSocket 연결을 다시 시도해요');
      this.startWs();
    } finally {
      this.switching = false;
    }
  }
}

export function createTransport(mode: 'auto' | 'ws' | 'http', deps: TransportDeps): Transport {
  if (mode === 'ws') return new WsTransport(deps);
  if (mode === 'http') return new HttpTransport(deps);
  return new AutoTransport(deps);
}
