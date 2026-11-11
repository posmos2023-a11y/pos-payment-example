// HTTP·WebSocket 서버와 라우팅.
//   /pos/ws, /pos/poll, /pos/events   POS 플러그인 접속 창구 (매장 토큰 인증)
//   /toss/webhook                     토스 결제 웹훅 (서명 인증)
//   /, /api/*                         정비 전산 흉내 화면 (인증 없음. 127.0.0.1 전용의 별도 포트에서만 연다)
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { WebSocketServer } from 'ws';
import { AppError, Store, WO } from './store.js';
import { Payments } from './payments.js';
import { Hub, MAX_EVENT_BATCH, validClientId } from './hub.js';
import { MAX_BODY_BYTES, TossClient, verifyWebhook } from './toss.js';
import { TossWebhookProcessor } from './webhook.js';

const INDEX_HTML = new URL('../public/index.html', import.meta.url);
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'Authorization, Content-Type',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
};

/** 연결 하나를 감싼다. hub 는 send/close/closed/ready/clientId 만 쓴다. */
class WsConn {
  constructor(ws) {
    this.ws = ws;
    this.clientId = null;
    this.ready = false;
    this.closed = false;
    this.lastRx = performance.now();
    this.pingTimer = null;
  }

  send(obj) {
    if (this.closed || this.ws.readyState !== 1) throw new Error('WebSocket 이 닫혔어요');
    this.ws.send(JSON.stringify(obj));
  }

  close() {
    this.closed = true;
    clearInterval(this.pingTimer);
    try {
      this.ws.close(1000);
    } catch { /* 이미 닫힘 */ }
    setTimeout(() => this.ws.terminate(), 2000).unref(); // 상대가 닫기에 응답하지 않으면 끊는다
  }

  /** 25초마다 ping, 단말이 70초 동안 아무 메시지도 없으면 연결을 끊는다. */
  startPing(intervalMs, idleMs) {
    if (this.pingTimer) return;
    this.pingTimer = setInterval(() => {
      if (this.closed) return clearInterval(this.pingTimer);
      if (performance.now() - this.lastRx > idleMs) return this.ws.terminate();
      try {
        this.send({ type: 'ping', t: Date.now() });
      } catch { /* 닫히는 중 */ }
    }, intervalMs);
    this.pingTimer.unref();
  }
}

function sendJson(res, status, body, extra = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(data), ...extra });
  res.end(data);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        req.removeAllListeners('data');
        reject(new AppError(413, 'PAYLOAD_TOO_LARGE', '본문이 너무 커요'));
      } else {
        chunks.push(chunk);
      }
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req, limit = MAX_BODY_BYTES) {
  const raw = await readBody(req, limit);
  try {
    const value = JSON.parse(raw.toString('utf8') || '{}');
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('not object');
    return value;
  } catch {
    throw new AppError(400, 'BAD_REQUEST', '본문이 JSON 객체가 아니에요');
  }
}

function bearerToken(req) {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.authorization ?? '');
  return m ? m[1] : '';
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOCAL_HOST_RE = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

/**
 * 화면·내부 API 는 이 PC 에서 직접 접속한 요청만 받는다(프록시 헤더가 있으면 거절).
 * 이 검사만으로는 부족하다: 리버스 프록시나 터널 뒤에서는 모든 요청이 127.0.0.1 에서 온 것처럼 보이고,
 * 프록시가 X-Forwarded-For 를 붙이지 않을 수도 있다. 그래서 화면은 POS 포트와 다른 포트에 따로 연다(listen 의 adminPort).
 * 프록시는 POS 포트만 넘기므로 화면이 밖으로 나가지 않는다. 이 검사는 그 위에 더하는 방어(다른 사이트가 이름을 바꿔 접근하는 것 차단)다.
 */
function assertLocal(req) {
  const direct = LOOPBACK.has(req.socket.remoteAddress ?? '') && !req.headers['x-forwarded-for'] && !req.headers.forwarded;
  if (!direct || !LOCAL_HOST_RE.test(req.headers.host ?? '')) {
    throw new AppError(403, 'LOCAL_ONLY', '이 화면은 이 PC 에서만 쓸 수 있어요');
  }
}

/**
 * 서버 만들기. 테스트에서는 clock·fetchImpl·timings 를 바꿔 끼운다.
 * @param {object} opts
 */
export function createApp({
  shops = [], config = {}, clock = { now: () => Date.now() }, logger = () => {}, fetchImpl, persistShops, timings = {},
} = {}) {
  const t = {
    pingIntervalMs: 25_000, idleTimeoutMs: 70_000, sweepIntervalMs: 2_000, memoRecheckMs: 30_000, ...timings,
  };
  const store = new Store({ clock, persistShops });
  store.loadShops(shops);
  const origAddEvent = store.addEvent.bind(store);
  store.addEvent = (level, text, shopId = 0) => { // 화면용 로그와 콘솔 로그를 함께 남긴다(토큰·키는 넣지 않는다)
    origAddEvent(level, text, shopId);
    logger(level, text);
  };
  const payments = new Payments(store);
  const toss = new TossClient({
    accessKey: config.tossAccessKey ?? '', secretKey: config.tossSecretKey ?? '',
    baseUrl: config.tossBaseUrl ?? 'https://open-api.tossplace.com/api-public/openapi/v1', fetchImpl,
  });
  const webhook = new TossWebhookProcessor({ store, payments, toss, memoRecheckMs: t.memoRecheckMs, retryDelaysMs: t.retryDelaysMs });
  // 단말이 보낸 payment.paid 를 얼마나 믿을지:
  //  - Open API 키가 있으면 "결제가 있었다"는 신호로만 쓰고, 주문을 토스에서 조회해 확인된 값으로 반영한다.
  //  - 키가 없으면(로컬 시험) 단말이 보낸 값을 그대로 반영한다. 매장 토큰만 알면 결제완료를 만들 수 있으니 운영에서는 쓰지 마세요.
  const verifyPosPaid = toss.configured ? (shop, msg) => webhook.posPaid(shop, msg) : null;
  const hub = new Hub({ store, payments, clock, verifyPosPaid });

  // ---- /pos/* -----------------------------------------------------------------------
  async function handlePos(req, res, url) {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS);
      return res.end();
    }
    const shop = store.shopByToken(bearerToken(req));
    if (!shop) return sendJson(res, 401, { error: 'UNAUTHORIZED' }, CORS);

    if (url.pathname === '/pos/poll' && req.method === 'GET') {
      const clientId = validClientId(url.searchParams.get('clientId'));
      if (clientId === null) return sendJson(res, 400, { error: 'BAD_REQUEST' }, CORS);
      let aborted = false;
      res.on('close', () => { if (!res.writableEnded) aborted = true; });
      const wait = url.searchParams.has('wait') ? Number(url.searchParams.get('wait')) : 20;
      const commands = await hub.poll(shop, clientId, wait, () => aborted);
      return sendJson(res, 200, { commands }, CORS);
    }
    if (url.pathname === '/pos/events' && req.method === 'POST') {
      const body = await readJson(req);
      const clientId = validClientId(body.clientId);
      if (clientId === null || (body.messages !== undefined && !Array.isArray(body.messages))) {
        return sendJson(res, 400, { error: 'BAD_REQUEST' }, CORS);
      }
      const replies = [];
      for (const msg of (body.messages ?? []).slice(0, MAX_EVENT_BATCH)) {
        if (msg && typeof msg === 'object' && !Array.isArray(msg)) replies.push(...hub.handleMessage(shop, clientId, msg, 'http'));
      }
      return sendJson(res, 200, { ok: true, replies }, CORS);
    }
    return sendJson(res, 404, { error: 'NOT_FOUND' }, CORS);
  }

  // ---- WebSocket -------------------------------------------------------------------
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_BODY_BYTES });

  function rejectUpgrade(socket, status, reason, body) {
    const data = JSON.stringify(body);
    socket.end(
      `HTTP/1.1 ${status} ${reason}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(data)}\r\n` +
      `Connection: close\r\n\r\n${data}`,
    );
  }

  function onUpgrade(req, socket, head) {
    socket.on('error', () => {});
    // 'upgrade' 리스너에서 던진 예외는 잡아 줄 곳이 없어 프로세스가 죽는다. 인증 전에 도는 코드라 전체를 감싼다.
    try {
      const pathname = (req.url ?? '/').split('?')[0]; // 쿼리(c=...)는 읽지 않는다
      if (pathname !== '/pos/ws') return rejectUpgrade(socket, 404, 'Not Found', { error: 'NOT_FOUND' });
      const shop = store.shopByToken(bearerToken(req));
      if (!shop) return rejectUpgrade(socket, 401, 'Unauthorized', { error: 'UNAUTHORIZED' }); // 업그레이드 전에 거절
      wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, shop));
    } catch (err) {
      store.addEvent('error', `WS 업그레이드 처리 오류: ${err instanceof Error ? err.message : 'unknown'}`);
      socket.destroy();
    }
  }

  function onConnection(ws, shop) {
    const conn = new WsConn(ws);
    ws.on('error', () => {});
    ws.on('message', (data, isBinary) => {
      conn.lastRx = performance.now();
      if (isBinary) return;
      try {
        let msg = null;
        try {
          msg = JSON.parse(data.toString('utf8'));
        } catch { /* 아래에서 처리 */ }
        if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) {
          if (conn.clientId) conn.send({ type: 'error', code: 'BAD_MESSAGE', message: 'JSON 객체가 아니에요' });
          return; // hello 전에는 아무것도 보내지 않는다
        }
        if (msg.type === 'hello') {
          hub.onWsHello(shop, conn, msg);
          if (conn.clientId) conn.startPing(t.pingIntervalMs, t.idleTimeoutMs);
        } else if (conn.clientId) {
          hub.handleMessage(shop, conn.clientId, msg, 'ws');
        }
      } catch (err) {
        store.addEvent('error', `WS 메시지 처리 오류: ${err instanceof Error ? err.message : 'unknown'}`, shop.id);
      }
    });
    ws.on('close', () => {
      clearInterval(conn.pingTimer);
      hub.onWsClosed(shop.id, conn);
    });
  }

  // ---- /toss/webhook ---------------------------------------------------------------
  async function handleWebhook(req, res) {
    if (req.method !== 'POST') return sendJson(res, 404, { error: 'NOT_FOUND' });
    const rawBody = await readBody(req, MAX_BODY_BYTES); // 서명은 받은 그대로의 바이트로 검증한다
    const v = verifyWebhook({ secret: config.tossWebhookSecret, headers: req.headers, rawBody, nowMs: clock.now() });
    if (!v.ok) {
      if (v.status === 401) store.addEvent('warn', '토스 웹훅 서명 검증 실패');
      return sendJson(res, v.status, { error: v.error });
    }
    let body;
    try {
      body = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return sendJson(res, 400, { error: '본문이 올바른 JSON 이 아니에요' });
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) return sendJson(res, 400, { error: '본문은 JSON 객체여야 해요' });
    if (!store.markWebhookSeen(v.id)) return sendJson(res, 200, { ok: true, duplicate: true }); // 같은 웹훅은 한 번만
    sendJson(res, 200, { ok: true }); // 먼저 응답하고
    webhook.handle(body); // 처리는 비동기로
  }

  // ---- 정비 전산 흉내 화면 / 내부 API (로컬 전용) ------------------------------------------
  function workOrderView(wo) {
    return {
      id: wo.id, shopId: wo.shopId, label: wo.label, lines: wo.lines, total: store.total(wo),
      status: wo.status, reviewReason: wo.reviewReason, posState: wo.posState, posError: wo.posError,
      paymentId: wo.paymentId, orderId: wo.orderId, paidAmount: wo.paidAmount, createdAt: wo.createdAt,
    };
  }

  function getWorkOrder(id) {
    const wo = store.workOrders.get(Number(id));
    if (!wo) throw new AppError(404, 'NOT_FOUND', '작업을 찾을 수 없어요');
    return wo;
  }

  function parseNewWorkOrder(body) {
    const shop = store.shops.get(Number(body.shopId));
    if (!shop) throw new AppError(400, 'BAD_REQUEST', '매장을 선택하세요');
    const label = typeof body.label === 'string' ? body.label.trim().slice(0, 80) : '';
    if (!label) throw new AppError(400, 'BAD_REQUEST', '작업 이름을 입력하세요');
    const lines = [];
    for (const raw of Array.isArray(body.lines) ? body.lines : []) {
      const title = typeof raw?.title === 'string' ? raw.title.trim().slice(0, 80) : '';
      if (!title) continue; // 이름이 빈 줄은 건너뛴다
      const unitPrice = raw.unitPrice;
      const quantity = raw.quantity;
      if (!Number.isInteger(unitPrice) || unitPrice < 0) throw new AppError(400, 'BAD_REQUEST', `단가가 올바르지 않아요: ${title}`);
      if (!Number.isInteger(quantity) || quantity < 1) throw new AppError(400, 'BAD_REQUEST', `수량이 올바르지 않아요: ${title}`);
      lines.push({ title, unitPrice, quantity, productCode: `ITEM-${lines.length + 1}`, category: '정비' });
    }
    if (lines.length === 0) throw new AppError(400, 'BAD_REQUEST', '품목을 한 줄 이상 입력하세요');
    return { shop, label, lines };
  }

  async function handleLocal(req, res, url) {
    assertLocal(req);
    const { pathname } = url;
    if (req.method === 'GET' && pathname === '/') {
      const html = await readFile(INDEX_HTML);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(html);
    }
    if (req.method === 'GET' && pathname === '/api/state') {
      return sendJson(res, 200, {
        now: clock.now(),
        tossWebhookConfigured: Boolean(config.tossWebhookSecret),
        tossOpenApiConfigured: toss.configured,
        shops: [...store.shops.values()].map((s) => ({
          id: s.id, name: s.name, merchantId: s.merchantId ?? '', clients: hub.clientList(s.id),
          workOrders: [...store.workOrders.values()].filter((w) => w.shopId === s.id).map(workOrderView).reverse(),
          commands: [...store.commands.values()].filter((c) => c.shopId === s.id).slice(-15).reverse()
            .map((c) => ({ id: c.id, workOrderId: c.workOrderId, status: c.status, lines: c.payload.lines.length, error: c.error })),
        })),
        events: store.events.slice(-60).reverse(),
      });
    }
    // 쓰기 요청은 application/json 만 받는다(다른 사이트의 form 전송으로 눌리는 것을 막는다)
    if (req.method !== 'POST') throw new AppError(404, 'NOT_FOUND', '없는 주소예요');
    if (!/^application\/json/i.test(req.headers['content-type'] ?? '')) throw new AppError(415, 'UNSUPPORTED', 'JSON 만 받아요');
    if (pathname === '/api/work-orders') {
      const { shop, label, lines } = parseNewWorkOrder(await readJson(req));
      return sendJson(res, 201, workOrderView(store.createWorkOrder(shop.id, label, lines)));
    }
    const m = /^\/api\/work-orders\/(\d+)\/(cart|remove|confirm-paid)$/.exec(pathname);
    if (m) {
      const wo = getWorkOrder(m[1]);
      const body = await readJson(req);
      if (m[2] === 'cart') { // [담기]
        hub.queueSync(wo, { startPayment: body.startPayment !== false, exclusive: true });
      } else if (m[2] === 'remove') { // [POS에서 빼기]
        hub.queueSync(wo, { startPayment: false, exclusive: false, empty: true });
      } else { // [결제완료로 처리] (확인 필요 작업만)
        if (wo.status !== WO.REVIEW) throw new AppError(409, 'NOT_REVIEW', '확인 필요 상태의 작업만 처리할 수 있어요');
        payments.confirmPaid(wo);
      }
      return sendJson(res, 200, workOrderView(wo));
    }
    throw new AppError(404, 'NOT_FOUND', '없는 주소예요');
  }

  // ---- 서버 ------------------------------------------------------------------------
  let adminServer = null; // 화면·내부 API 전용 서버(항상 127.0.0.1 에만 연다)
  let adminOnPublic = false; // listen() 에 adminPort 를 주지 않았을 때만 true: 화면을 POS 포트에 함께 연다(테스트용)

  /** admin=true 는 화면 전용 서버로 들어온 요청. 그 서버는 화면·내부 API 만, POS 포트는 그 밖의 것만 받는다. */
  async function route(req, res, admin) {
    try {
      const url = new URL(req.url ?? '/', 'http://x');
      const isAdminPath = url.pathname === '/' || url.pathname.startsWith('/api/');
      if (admin) return isAdminPath ? await handleLocal(req, res, url) : sendJson(res, 404, { error: 'NOT_FOUND' });
      if (url.pathname.startsWith('/pos/')) return await handlePos(req, res, url);
      if (url.pathname === '/toss/webhook') return await handleWebhook(req, res);
      if (url.pathname === '/health') return sendJson(res, 200, { ok: true });
      if (isAdminPath && adminOnPublic) return await handleLocal(req, res, url);
      return sendJson(res, 404, { error: 'NOT_FOUND' });
    } catch (err) {
      const isApp = err instanceof AppError;
      if (!isApp) store.addEvent('error', `요청 처리 오류: ${err instanceof Error ? err.message : 'unknown'}`);
      if (res.headersSent) return res.end();
      const extra = req.url?.startsWith('/pos/') ? { ...CORS } : {};
      if (isApp && err.status === 413) {
        res.once('finish', () => req.destroy()); // 큰 본문을 더 받지 않는다
        extra.connection = 'close';
      }
      // /pos/* 의 400·413 은 플러그인이 메시지를 버린다는 뜻이라, 일시 장애에는 500 을 쓴다
      return sendJson(res, isApp ? err.status : 500, { error: isApp ? err.code : 'INTERNAL', message: isApp ? err.message : undefined }, extra);
    }
  }

  const server = http.createServer((req, res) => { route(req, res, false); });
  server.on('upgrade', onUpgrade);
  let sweepTimer = null;

  function listenOn(srv, port, host) {
    return new Promise((resolve, reject) => {
      srv.once('error', reject);
      srv.listen(port, host, () => {
        srv.off('error', reject);
        resolve(srv.address().port);
      });
    });
  }

  return {
    server, store, hub, payments, webhook, toss, clock,
    adminPort: null, // 화면 전용 서버의 포트(listen 에 adminPort 를 줬을 때)
    /**
     * POS 창구(port, host)를 연다. 돌려주는 값은 POS 포트.
     * adminPort 를 주면 화면·내부 API 는 127.0.0.1 의 그 포트에서만 열리고 POS 포트에서는 404 가 된다(실행 시 기본).
     * adminPort 를 주지 않으면 화면을 POS 포트에 함께 연다. 테스트 편의용이니 프록시 뒤에 두는 서버에는 쓰지 마세요.
     */
    async listen(port, host = '127.0.0.1', { adminPort } = {}) {
      const posPort = await listenOn(server, port, host);
      if (adminPort === undefined) {
        adminOnPublic = true;
      } else {
        adminServer = http.createServer((req, res) => { route(req, res, true); });
        this.adminPort = await listenOn(adminServer, adminPort, '127.0.0.1');
      }
      sweepTimer = setInterval(() => hub.sweep(), t.sweepIntervalMs);
      sweepTimer.unref();
      return posPort;
    },
    async close() {
      clearInterval(sweepTimer);
      webhook.close();
      hub.shutdown();
      for (const ws of wss.clients) ws.terminate();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      if (adminServer) {
        adminServer.closeAllConnections();
        await new Promise((resolve) => adminServer.close(resolve));
      }
    },
  };
}
