// 메모리 저장소. 예제라서 DB 없이 Map 에 담는다 — 서버를 끄면 작업·명령·결제 기록이 사라진다.
// 실제 서비스에서는 이 파일의 내용을 DB 테이블(매장, 작업, 명령, 처리한 결제 ID, 이벤트 로그)로 바꾸세요.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

// 작업(정비 전산의 작업 1건)의 결제 상태
export const WO = {
  PENDING: 'PENDING_PAYMENT', // 결제대기
  PAID: 'PAID', // 결제완료
  REFUNDED: 'REFUNDED', // 취소(환불)
  REVIEW: 'REVIEW', // 확인 필요 (사유는 reviewReason)
};

export class AppError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const sha = (s) => createHash('sha256').update(String(s)).digest();
const MAX_EVENTS = 200;
const MAX_SEEN = 20000;

export class Store {
  /**
   * @param {{clock: {now(): number}, persistShops?: (shops: object[]) => void}} opts
   */
  constructor({ clock, persistShops = () => {} }) {
    this.clock = clock;
    this.persistShops = persistShops;
    this.shops = new Map(); // id -> {id, name, token, merchantId?}
    this.workOrders = new Map(); // id(양의 정수) -> 작업
    this.commands = new Map(); // id -> 명령
    this.seen = new Map(); // 이미 받은 결제 메시지 "(매장)|종류|paymentId" -> 출처 등급(1 단말 보고, 2 토스로 확인)
    this.webhookIds = new Set(); // 이미 받은 토스 웹훅 id
    this.events = []; // 화면에 보여 줄 최근 이벤트
    this.nextWorkOrderId = 1;
    this.lastSeq = 0;
  }

  // ---- 매장 ----
  loadShops(list) {
    for (const s of list) this.shops.set(s.id, { ...s });
  }

  shopList() {
    return [...this.shops.values()].map(({ id, name, token, merchantId }) => ({
      id, name, token, ...(merchantId ? { merchantId } : {}),
    }));
  }

  /** 토큰으로 매장 찾기. 모든 매장과 같은 방식으로 상수 시간 비교한다. */
  shopByToken(token) {
    if (typeof token !== 'string' || token === '') return null;
    const given = sha(token);
    let found = null;
    for (const shop of this.shops.values()) {
      if (timingSafeEqual(given, sha(shop.token))) found = shop;
    }
    return found;
  }

  shopByMerchant(merchantId) {
    for (const shop of this.shops.values()) if (shop.merchantId === merchantId) return shop;
    return null;
  }

  /** hello 로 알려 온 토스 가맹점 ID 를 그 매장과 연결해 저장한다. */
  setMerchantId(shopId, merchantId) {
    const shop = this.shops.get(shopId);
    if (!shop || shop.merchantId === merchantId) return;
    shop.merchantId = merchantId;
    this.persistShops(this.shopList());
  }

  // ---- 작업 ----
  createWorkOrder(shopId, label, lines) {
    const wo = {
      id: this.nextWorkOrderId++,
      shopId,
      label,
      lines: lines.map((ln, i) => ({
        lineNo: i + 1,
        productCode: ln.productCode ?? '',
        title: ln.title,
        category: ln.category ?? '',
        unitPrice: ln.unitPrice,
        quantity: ln.quantity,
        taxFree: ln.taxFree === true,
      })),
      status: WO.PENDING,
      reviewReason: '',
      posState: 'NONE', // NONE | QUEUED | APPLIED | REMOVED | FAILED | EXPIRED
      posError: '',
      lastCommandId: null,
      paymentId: '',
      orderId: '',
      paidAmount: 0,
      createdAt: this.clock.now(),
    };
    this.workOrders.set(wo.id, wo);
    return wo;
  }

  /** 작업 합계(원, VAT 포함). */
  total(wo) {
    return wo.lines.reduce((sum, ln) => sum + ln.unitPrice * ln.quantity, 0);
  }

  // ---- 명령 ----
  newCommand(shopId, workOrderId, kind, payload) {
    const now = this.clock.now();
    this.lastSeq = Math.max(this.lastSeq + 1, now); // 정렬용. 단조 증가
    const cmd = {
      id: `c_${randomBytes(8).toString('hex')}`, // 영구히 고유(재시작해도 겹치지 않는 난수)
      seq: this.lastSeq,
      shopId,
      workOrderId,
      kind,
      payload,
      status: 'PENDING', // PENDING -> SENT -> DONE | FAILED, 그 밖에 SUPERSEDED | EXPIRED
      clientId: '',
      createdAt: now,
      sentAt: 0,
      error: '',
    };
    this.commands.set(cmd.id, cmd);
    return cmd;
  }

  /** 같은 작업의 아직 안 보낸(PENDING) SYNC_CART 를 SUPERSEDED 로 바꾸고 그 목록을 돌려준다. */
  supersedePending(workOrderId) {
    const out = [];
    for (const cmd of this.commands.values()) {
      if (cmd.workOrderId === workOrderId && cmd.kind === 'SYNC_CART' && cmd.status === 'PENDING') {
        cmd.status = 'SUPERSEDED';
        out.push(cmd);
      }
    }
    return out;
  }

  // ---- 중복 제거 ----
  /**
   * 처음 보는 키이거나 전에 본 것보다 더 믿을 만한 출처(rank 가 큼)면 true(기록함), 아니면 false.
   * rank: 1 = 단말이 보낸 값 그대로, 2 = 토스(웹훅·주문 조회)로 확인한 값.
   * 단말이 먼저 불완전하게 보고한 결제를, 뒤에 온 토스 확인 결과가 한 번은 바로잡을 수 있게 하려는 것이다.
   */
  markSeen(key, rank = 1) {
    const prev = this.seen.get(key) ?? 0;
    if (prev >= rank) return false;
    if (prev === 0 && this.seen.size >= MAX_SEEN) this.seen.delete(this.seen.keys().next().value);
    this.seen.set(key, rank);
    return true;
  }

  /** 그 키를 본 적이 있으면 출처 등급(1·2), 없으면 0. */
  seenRank(key) {
    return this.seen.get(key) ?? 0;
  }

  markWebhookSeen(id) {
    if (this.webhookIds.has(id)) return false;
    if (this.webhookIds.size >= MAX_SEEN) this.webhookIds.delete(this.webhookIds.values().next().value);
    this.webhookIds.add(id);
    return true;
  }

  // ---- 이벤트 로그 ----
  addEvent(level, text, shopId = 0) {
    this.events.push({ at: this.clock.now(), level, shopId, text });
    if (this.events.length > MAX_EVENTS) this.events.shift();
  }
}
