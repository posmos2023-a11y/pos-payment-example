// 테스트 공용 도구: 실제 서버를 임의 포트로 띄우고, ws 클라이언트로 접속한다.
import WebSocket from 'ws';
import { createApp } from '../src/server.js';

export const SHOPS = [
  { id: 1, name: '매장 A', token: 'token-A-0123456789abcdef' },
  { id: 2, name: '매장 B', token: 'token-B-0123456789abcdef' },
];

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 조건이 참이 될 때까지 기다린다. */
export async function until(fn, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(10);
  }
  throw new Error('시간 안에 조건이 충족되지 않았어요');
}

export function fakeClock(start = Date.now()) {
  let now = start;
  return { now: () => now, advance: (ms) => { now += ms; } };
}

export async function startApp(opts = {}) {
  const app = createApp({ shops: SHOPS.map((s) => ({ ...s })), ...opts });
  const port = await app.listen(0, '127.0.0.1');
  return { app, port, base: `http://127.0.0.1:${port}`, close: () => app.close() };
}

/** 가짜 POS 단말(WebSocket). */
export class PosClient {
  constructor(port, token, clientId = 'client-1') {
    this.port = port;
    this.token = token;
    this.clientId = clientId;
    this.messages = [];
    this.closed = false;
  }

  /** 접속. 거절되면 {status} 를 담아 reject 한다. */
  connect(query = '?c=abc123') {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`ws://127.0.0.1:${this.port}/pos/ws${query}`, {
        headers: this.token ? { Authorization: `Bearer ${this.token}` } : {},
      });
      this.ws.on('open', () => resolve(this));
      this.ws.on('unexpected-response', (_req, res) => reject(Object.assign(new Error('rejected'), { status: res.statusCode })));
      this.ws.on('error', () => {});
      this.ws.on('message', (d) => this.messages.push(JSON.parse(d.toString())));
      this.ws.on('close', () => { this.closed = true; });
    });
  }

  send(obj) { this.ws.send(JSON.stringify(obj)); }

  hello(extra = {}) {
    this.send({ type: 'hello', clientId: this.clientId, pluginName: 'test', pluginVersion: '1', transport: 'ws', processedIds: [], ...extra });
  }

  async waitFor(pred, ms = 2000) {
    return until(() => this.messages.find(pred), ms);
  }

  /** hello 를 보내고 welcome 을 기다린다. */
  async join(extra = {}) {
    this.hello(extra);
    return this.waitFor((m) => m.type === 'welcome');
  }

  commands() { return this.messages.filter((m) => m.type === 'command').map((m) => m.command); }

  close() { this.ws?.close(); }
}

/** 내부 API / POS HTTP 호출 */
export async function http(base, method, path, { token, body, headers = {} } = {}) {
  const h = { ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  let payload;
  if (body !== undefined) {
    h['content-type'] ??= 'application/json';
    payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  }
  const res = await fetch(base + path, { method, headers: h, body: payload });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 본문이 JSON 이 아님 */ }
  return { status: res.status, headers: res.headers, json, text };
}

export const api = (base, method, path, body) => http(base, method, path, { body });
export const events = (base, token, clientId, messages) => http(base, 'POST', '/pos/events', { token, body: { clientId, messages } });

/** 작업 1건 만들기(품목 2줄: 합계 81000원). */
export async function makeWorkOrder(base, shopId = 1, label = '12가3456 홍길동') {
  const r = await api(base, 'POST', '/api/work-orders', {
    shopId, label,
    lines: [{ title: '엔진오일', unitPrice: 69000, quantity: 1 }, { title: '오일필터', unitPrice: 12000, quantity: 1 }],
  });
  if (r.status !== 201) throw new Error(`작업 생성 실패 ${r.status}`);
  return r.json;
}
