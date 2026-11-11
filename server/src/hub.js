// POS 단말 허브: 매장별 단말 목록, 활성 단말 1대, 명령 큐(보내기·재전송·만료), 플러그인 메시지 처리.
//
// 연결 객체(conn)는 WebSocket 을 감싼 것으로 {send(obj), close(), closed, ready, clientId} 만 쓴다.
// HTTP 롱폴링 단말은 conn 이 없다(poll 요청 안에서 명령을 가져간다).
import { AppError, WO } from './store.js';

export const RESEND_MS = 30_000; // SENT 후 ack 가 없으면 다시 보낼 대상으로
export const EXPIRE_MS = 30 * 60_000; // 이 시간이 넘도록 끝나지 않은 명령은 만료
export const ACTIVE_GRACE_MS = 20_000; // 활성 단말이 끊겨도 이 시간 동안은 다른 단말로 넘기지 않는다
export const HTTP_ONLINE_MS = 45_000; // HTTP 단말은 이 시간 안에 요청이 있었으면 온라인
export const POLL_MAX_WAIT_S = 25;
export const POLL_MAX_COMMANDS = 20;
export const MAX_CLIENT_ID_LEN = 120;
export const MAX_EVENT_BATCH = 200;

const OPEN_FOR_ACK = ['PENDING', 'SENT', 'EXPIRED'];
const iso = (ms) => new Date(ms).toISOString();

export function validClientId(raw) {
  return typeof raw === 'string' && raw.trim() !== '' && raw.length <= MAX_CLIENT_ID_LEN ? raw.trim() : null;
}

export function commandJson(cmd) {
  return { id: cmd.id, seq: cmd.seq, kind: cmd.kind, createdAt: iso(cmd.createdAt), payload: cmd.payload };
}

export class Hub {
  /**
   * verifyPosPaid(shop, msg): 주면 단말의 payment.paid 를 바로 반영하지 않고 이 함수에 넘긴다
   * (토스에서 확인한 뒤 반영하는 경로). 없으면 단말이 보낸 값을 그대로 반영한다(로컬 시험용).
   */
  constructor({ store, payments, clock, serverVersion = '1.0.0', verifyPosPaid = null }) {
    this.store = store;
    this.payments = payments;
    this.verifyPosPaid = verifyPosPaid;
    this.clock = clock;
    this.serverVersion = serverVersion;
    this.clients = new Map(); // shopId -> Map(clientId -> client)
    this.active = new Map(); // shopId -> 활성 clientId
    this.closing = false;
  }

  // ---- 단말 ----------------------------------------------------------------------------
  #shopClients(shopId) {
    let m = this.clients.get(shopId);
    if (!m) this.clients.set(shopId, (m = new Map()));
    return m;
  }

  #upsert(shopId, clientId, transport) {
    const m = this.#shopClients(shopId);
    let c = m.get(clientId);
    if (!c) {
      c = { clientId, shopId, transport, pluginVersion: '', merchantId: '', lastSeen: 0, conn: null, pollWake: null, pollGen: 0, lastDraft: null };
      m.set(clientId, c);
    }
    c.transport = transport;
    c.lastSeen = this.clock.now();
    return c;
  }

  isOnline(c) {
    if (c.conn) return !c.conn.closed;
    return c.transport === 'http' && this.clock.now() - c.lastSeen < HTTP_ONLINE_MS;
  }

  /**
   * 활성 단말 정하기. 현재 활성 단말이 온라인이거나 끊긴 지 20초가 안 됐으면 그대로 둔다.
   * 아니면 preferredId(방금 hello/poll 한 단말) 또는 가장 최근에 보인 온라인 단말이 넘겨받는다.
   */
  ensureActive(shopId, preferredId) {
    const m = this.#shopClients(shopId);
    const cur = m.get(this.active.get(shopId));
    if (cur && (this.isOnline(cur) || this.clock.now() - cur.lastSeen < ACTIVE_GRACE_MS)) return;
    const online = [...m.values()].filter((c) => this.isOnline(c));
    const next = online.find((c) => c.clientId === preferredId) ?? online.sort((a, b) => b.lastSeen - a.lastSeen)[0];
    if (next) this.active.set(shopId, next.clientId);
  }

  /** 화면용 단말 목록. */
  clientList(shopId) {
    const activeId = this.active.get(shopId);
    return [...this.#shopClients(shopId).values()].map((c) => ({
      clientId: c.clientId,
      transport: c.conn && !c.conn.closed ? 'ws' : c.transport,
      online: this.isOnline(c),
      active: c.clientId === activeId,
      pluginVersion: c.pluginVersion,
      merchantId: c.merchantId,
      lastSeen: c.lastSeen,
      draft: c.lastDraft,
    }));
  }

  // ---- 명령 만들기 ----------------------------------------------------------------------
  /**
   * [담기] / [POS에서 빼기]: 작업의 현재 라인 전체를 SYNC_CART 명령으로 만든다.
   * lines 가 빈 작업은 "POS 에서 빼기"가 된다. 같은 작업의 아직 안 보낸 SYNC_CART 는 SUPERSEDED 로 합친다.
   */
  queueSync(wo, { startPayment, exclusive, empty = false }) {
    if (wo.status === WO.PAID) throw new AppError(409, 'ALREADY_PAID', '이미 결제완료된 작업이라 다시 담을 수 없어요');
    const lines = empty
      ? []
      : wo.lines.map((ln) => ({
          key: `gm-${wo.id}-${ln.lineNo}`, // gm-{작업ID}-{라인ID}. 작업ID 는 양의 정수, `_` 금지
          productCode: ln.productCode,
          title: ln.title,
          category: ln.category,
          unitPrice: ln.unitPrice,
          quantity: ln.quantity,
          taxFree: ln.taxFree,
        }));
    let sp = startPayment;
    let ex = exclusive;
    for (const old of this.store.supersedePending(wo.id)) {
      sp ||= old.payload.startPayment === true;
      ex ||= old.payload.exclusive === true;
    }
    if (lines.length === 0) sp = ex = false;
    const cmd = this.store.newCommand(wo.shopId, wo.id, 'SYNC_CART', {
      workOrderId: wo.id, label: wo.label, lines, startPayment: sp, exclusive: ex,
    });
    wo.lastCommandId = cmd.id;
    wo.posState = 'QUEUED';
    wo.posError = '';
    if (wo.status === WO.REFUNDED && lines.length > 0) {
      Object.assign(wo, { status: WO.PENDING, paymentId: '', orderId: '', paidAmount: 0 }); // 환불된 작업은 다시 결제대기
    }
    this.store.addEvent('info', `[${lines.length > 0 ? '담기' : '빼기'}] 명령 ${cmd.id} 작업 #${wo.id}`, wo.shopId);
    this.deliver(wo.shopId);
    return cmd;
  }

  // ---- 명령 보내기 ----------------------------------------------------------------------
  #claim(shopId, clientId, limit) {
    const now = this.clock.now();
    const rows = [...this.store.commands.values()]
      .filter((c) => c.shopId === shopId && c.status === 'PENDING' && now - c.createdAt < EXPIRE_MS)
      .sort((a, b) => a.seq - b.seq)
      .slice(0, limit);
    for (const c of rows) Object.assign(c, { status: 'SENT', clientId, sentAt: now });
    return rows;
  }

  /** 이 매장의 대기 명령을 활성 단말에 보낸다(WebSocket 이면 바로, 롱폴링이면 깨워서). */
  deliver(shopId) {
    this.ensureActive(shopId);
    const c = this.#shopClients(shopId).get(this.active.get(shopId));
    if (!c) return;
    if (c.conn && c.conn.ready && !c.conn.closed) {
      const rows = this.#claim(shopId, c.clientId, 50);
      rows.forEach((cmd, i) => {
        try {
          c.conn.send({ type: 'command', command: commandJson(cmd) });
        } catch {
          for (const r of rows.slice(i)) r.status = 'PENDING'; // 못 보냈으면 다시 보낼 대상으로
        }
      });
    } else {
      this.#wakePollers(shopId);
    }
  }

  #wakePollers(shopId) {
    for (const c of this.#shopClients(shopId).values()) c.pollWake?.();
  }

  /** 주기적으로 부른다: 30초 재전송, 30분 만료, 활성 단말 인계, 보충 전달. */
  sweep() {
    const now = this.clock.now();
    for (const cmd of this.store.commands.values()) {
      if (cmd.status !== 'PENDING' && cmd.status !== 'SENT') continue;
      if (now - cmd.createdAt >= EXPIRE_MS) {
        cmd.status = 'EXPIRED';
        const wo = this.store.workOrders.get(cmd.workOrderId);
        if (wo && wo.lastCommandId === cmd.id && wo.status !== WO.PAID) {
          wo.posState = 'EXPIRED';
          wo.posError = 'POS 가 30분 안에 받지 못해 만료됐어요';
        }
        this.store.addEvent('warn', `명령 ${cmd.id} 만료(30분)`, cmd.shopId);
      } else if (cmd.status === 'SENT' && now - cmd.sentAt >= RESEND_MS) {
        cmd.status = 'PENDING'; // ack 가 없으면 다시 보낸다(플러그인은 같은 id 를 중복 처리하지 않는다)
      }
    }
    for (const [shopId, m] of this.clients) {
      for (const c of m.values()) if (c.conn && !c.conn.closed) c.lastSeen = now; // 소켓이 살아 있는 동안 갱신
      this.deliver(shopId);
    }
  }

  // ---- 명령 결과 ------------------------------------------------------------------------
  #complete(cmd, ok, error, superseded = false) {
    cmd.status = ok ? 'DONE' : 'FAILED';
    cmd.error = ok ? '' : (error || '').slice(0, 200);
    if (superseded) return; // 플러그인이 더 새 명령을 보고 건너뜀
    const wo = this.store.workOrders.get(cmd.workOrderId);
    if (!wo || wo.lastCommandId !== cmd.id || wo.status === WO.PAID) return; // 더 새 명령이 있거나 이미 결제됨
    if (ok) {
      wo.posState = cmd.payload.lines.length > 0 ? 'APPLIED' : 'REMOVED';
      wo.posError = '';
    } else {
      wo.posState = 'FAILED';
      wo.posError = cmd.error || 'POS 에 담지 못했어요';
    }
  }

  // ---- 플러그인 메시지 ------------------------------------------------------------------
  welcome() {
    return { type: 'welcome', serverVersion: this.serverVersion, serverTime: iso(this.clock.now()) };
  }

  /** hello(WS·HTTP 공통). welcome 을 돌려준다. */
  onHello(shop, clientId, msg, transport, conn = null) {
    const c = this.#upsert(shop.id, clientId, transport);
    if (conn) c.conn = conn;
    const version = typeof msg.pluginVersion === 'string' ? msg.pluginVersion.slice(0, 40) : '';
    if (version) c.pluginVersion = version;
    const merchantId = typeof msg.merchantId === 'string' ? msg.merchantId.trim() : '';
    if (merchantId && merchantId.length <= 64) {
      c.merchantId = merchantId;
      this.store.setMerchantId(shop.id, merchantId); // 웹훅이 어느 매장 것인지 찾는 데 쓴다
    }
    this.ensureActive(shop.id, clientId);
    // 이 단말에 보냈던(SENT) 명령은 일단 다시 보낼 대상으로 돌리고, 이미 처리했다고 알려 온 것만 DONE 으로 확정한다.
    for (const cmd of this.store.commands.values()) {
      if (cmd.shopId === shop.id && cmd.clientId === clientId && cmd.status === 'SENT') cmd.status = 'PENDING';
    }
    const processed = Array.isArray(msg.processedIds) ? msg.processedIds.filter((p) => typeof p === 'string').slice(0, 200) : [];
    for (const id of processed) {
      const cmd = this.store.commands.get(id);
      if (cmd && cmd.shopId === shop.id && OPEN_FOR_ACK.includes(cmd.status)) this.#complete(cmd, true, '');
    }
    this.store.addEvent('info', `POS 연결 hello (${transport}) 단말 ${clientId.slice(0, 8)}`, shop.id);
    return this.welcome();
  }

  /** WebSocket 의 hello: welcome 을 보낸 뒤에야 명령을 보낸다. */
  onWsHello(shop, conn, msg) {
    const clientId = validClientId(msg.clientId);
    if (clientId === null) return;
    const mine = this.#shopClients(shop.id);
    if (conn.clientId && conn.clientId !== clientId) {
      const prev = mine.get(conn.clientId);
      if (prev && prev.conn === conn) prev.conn = null; // 같은 연결이 다른 clientId 로 다시 hello
    }
    const old = mine.get(clientId)?.conn;
    if (old && old !== conn && !old.closed) old.close(); // 같은 clientId 의 이전 소켓은 서버가 닫는다
    conn.clientId = clientId;
    conn.ready = false;
    const welcome = this.onHello(shop, clientId, msg, 'ws', conn);
    conn.send(welcome);
    conn.ready = true;
    this.deliver(shop.id);
  }

  onWsClosed(shopId, conn) {
    conn.closed = true;
    if (!conn.clientId) return;
    const c = this.#shopClients(shopId).get(conn.clientId);
    if (!c || c.conn !== conn) return; // 이미 새 연결로 교체됨
    c.conn = null;
    c.lastSeen = this.clock.now(); // 이 시각부터 20초가 지나면 다른 단말이 활성이 될 수 있다
    for (const cmd of this.store.commands.values()) {
      if (cmd.shopId === shopId && cmd.clientId === c.clientId && cmd.status === 'SENT') cmd.status = 'PENDING';
    }
  }

  /** hello 이외의 단말 -> 서버 메시지 1개. 돌려줄 응답(replies) 배열을 돌려준다. */
  handleMessage(shop, clientId, msg, transport) {
    if (msg.type === 'hello') return [this.onHello(shop, clientId, msg, transport)];
    this.#upsert(shop.id, clientId, transport);
    const c = this.#shopClients(shop.id).get(clientId);
    switch (msg.type) {
      case 'ack':
        this.#onAck(shop, c, msg);
        break;
      case 'draft':
        if (msg.draft && typeof msg.draft === 'object') c.lastDraft = msg.draft;
        break;
      case 'payment.paid':
        if (this.verifyPosPaid) this.verifyPosPaid(shop, msg);
        else this.payments.paidFromPos(shop.id, msg);
        break;
      case 'payment.cancelled':
        this.payments.cancelledFromPos(shop.id, msg);
        break;
      case 'log':
        this.store.addEvent(msg.level === 'error' ? 'error' : msg.level === 'warn' ? 'warn' : 'info',
          `POS 로그: ${String(msg.message ?? '').slice(0, 300)}`, shop.id);
        break;
      default: // pong 과 모르는 type 은 무시
    }
    return [];
  }

  #onAck(shop, c, msg) {
    const cmd = typeof msg.commandId === 'string' ? this.store.commands.get(msg.commandId) : null;
    if (cmd && cmd.shopId === shop.id && OPEN_FOR_ACK.includes(cmd.status)) { // 이미 끝난 명령의 되풀이 ack 는 무시
      const ok = msg.ok === true;
      this.#complete(cmd, ok, typeof msg.error === 'string' ? msg.error : '', ok && msg.superseded === true);
      this.store.addEvent(ok ? 'info' : 'warn', `ack ${cmd.id} ${ok ? 'ok' : `실패: ${cmd.error}`}`, shop.id);
    }
    if (msg.draft && typeof msg.draft === 'object') c.lastDraft = msg.draft;
  }

  // ---- HTTP 롱폴링 ---------------------------------------------------------------------
  /**
   * GET /pos/poll. 보낼 명령이 있으면 바로, 없으면 waitSec(최대 25초)까지 기다린다.
   * 같은 clientId 로 새 poll 이 오면 이전 poll 은 빈 배열로 끝난다. 열린 WebSocket 이 있으면 poll 로는 주지 않는다.
   */
  async poll(shop, clientId, waitSec, isAborted = () => false) {
    const wait = Math.max(0, Math.min(Number.isFinite(waitSec) ? waitSec : 20, POLL_MAX_WAIT_S));
    const c = this.#upsert(shop.id, clientId, 'http'); // 처음 오는 단말의 poll 은 hello 와 같이 인정
    this.ensureActive(shop.id, clientId);
    const gen = ++c.pollGen;
    c.pollWake?.(); // 같은 단말의 옛 poll 을 깨워 끝낸다
    const deadline = Date.now() + wait * 1000;
    for (;;) {
      if (this.closing || isAborted() || gen !== c.pollGen) return [];
      if (!c.conn && this.active.get(shop.id) === clientId) {
        const rows = this.#claim(shop.id, clientId, POLL_MAX_COMMANDS);
        if (rows.length > 0) return rows.map(commandJson);
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) return [];
      let wake;
      await new Promise((resolve) => {
        const t = setTimeout(resolve, Math.min(remaining, 5000));
        wake = () => { clearTimeout(t); resolve(); };
        c.pollWake = wake;
      });
      if (c.pollWake === wake) c.pollWake = null;
      c.lastSeen = this.clock.now();
    }
  }

  /** 서버를 끌 때: 롱폴을 깨우고 WebSocket 을 닫는다. */
  shutdown() {
    this.closing = true;
    for (const m of this.clients.values()) {
      for (const c of m.values()) {
        c.pollWake?.();
        if (c.conn && !c.conn.closed) c.conn.close();
      }
    }
  }
}
