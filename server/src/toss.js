// 토스 쪽 처리: 웹훅 서명 검증, Open API 주문 조회, 주문 응답 해석.
// 키·시크릿 값은 로그나 오류 문구에 절대 넣지 않는다.
import { createHmac, timingSafeEqual } from 'node:crypto';

export const EVT_APPROVED = 'payment.payment.approved.v1';
export const EVT_CANCELLED = 'payment.payment.cancelled.v1';
export const MAX_SKEW_MS = 5 * 60 * 1000;
export const MAX_BODY_BYTES = 1024 * 1024;

// ---- 웹훅 서명 ----------------------------------------------------------------

/** "v1=" + hex(HMAC_SHA256(key=시크릿, msg=`${timestamp}.${원본 body 바이트}`)) */
export function signWebhook(secret, timestamp, rawBody) {
  const mac = createHmac('sha256', secret);
  mac.update(`${timestamp}.`);
  mac.update(rawBody); // 파싱한 JSON 이 아니라 받은 그대로의 바이트
  return `v1=${mac.digest('hex')}`;
}

/**
 * 웹훅 검증. 통과하면 {ok:true, id}, 아니면 {ok:false, status, error}.
 * 검사 순서: 시크릿 설정(503) -> 헤더(400) -> 시각 형식·오차(400) -> 서명(401).
 */
export function verifyWebhook({ secret, headers, rawBody, nowMs, maxSkewMs = MAX_SKEW_MS }) {
  if (!secret) return { ok: false, status: 503, error: '토스 웹훅 시크릿이 설정되지 않았어요' };
  const id = String(headers['x-toss-webhook-id'] ?? '').trim();
  const timestamp = String(headers['x-toss-timestamp'] ?? '').trim();
  const signature = String(headers['x-toss-signature'] ?? '').trim();
  if (!id || !timestamp || !signature) {
    return { ok: false, status: 400, error: 'x-toss-webhook-id, x-toss-timestamp, x-toss-signature 헤더가 필요해요' };
  }
  const sentMs = Number(timestamp);
  if (!/^\d+$/.test(timestamp) || !Number.isSafeInteger(sentMs)) {
    return { ok: false, status: 400, error: 'x-toss-timestamp 가 올바르지 않아요' };
  }
  if (Math.abs(nowMs - sentMs) > maxSkewMs) {
    return { ok: false, status: 400, error: 'x-toss-timestamp 가 허용 범위를 벗어났어요' };
  }
  const expected = Buffer.from(signWebhook(secret, timestamp, rawBody));
  const given = Buffer.from(signature);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return { ok: false, status: 401, error: 'UNAUTHORIZED' };
  }
  return { ok: true, id };
}

// ---- Open API 주문 조회 -----------------------------------------------------------

export class TossApiError extends Error {
  /** retryable=true 이면 나중에 다시 시도할 만한 오류(429·5xx·404·네트워크). */
  constructor(message, retryable) {
    super(message);
    this.retryable = retryable;
  }
}

export class TossClient {
  constructor({ accessKey, secretKey, baseUrl, fetchImpl = globalThis.fetch, timeoutMs = 10000 }) {
    this.accessKey = accessKey;
    this.secretKey = secretKey;
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  get configured() {
    return Boolean(this.accessKey && this.secretKey);
  }

  /** 주문 1건. 성공하면 응답의 success 객체를 돌려주고, 아니면 TossApiError. */
  async getOrder(merchantId, orderId) {
    if (!this.configured) throw new TossApiError('토스 Open API 키가 설정되지 않았어요', false);
    const url = `${this.baseUrl}/merchants/${encodeURIComponent(merchantId)}/order/orders/${encodeURIComponent(orderId)}`;
    let res;
    try {
      res = await this.fetchImpl(url, {
        headers: { 'x-access-key': this.accessKey, 'x-secret-key': this.secretKey, accept: 'application/json' },
        redirect: 'manual',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new TossApiError('토스 Open API 연결 실패', true); // 원래 오류에 요청 정보가 있을 수 있어 메시지는 새로 쓴다
    }
    if (res.status >= 500 || [404, 408, 429].includes(res.status)) {
      throw new TossApiError(`토스 Open API 응답 ${res.status}`, true);
    }
    if (res.status >= 300) throw new TossApiError(`토스 Open API 응답 ${res.status}`, false);
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* 아래에서 형식 오류로 처리 */
    }
    if (data === null || typeof data !== 'object') throw new TossApiError('토스 Open API 응답 형식이 올바르지 않아요', false);
    if (data.resultType === 'SUCCESS' && data.success && typeof data.success === 'object') return data.success;
    const code = String(data.error?.errorCode ?? '').slice(0, 60);
    throw new TossApiError(`토스 Open API 실패 ${code}`.trim(), false);
  }
}

// ---- 주문 응답 해석(순수 함수) -------------------------------------------------------

const MEMO_RE = /^#(\d+)(\s|$)/; // 플러그인이 항목 메모에 넣는 "#작업ID 라벨"

/** lineItems[].memo 의 작업 ID 들(중복 제거, 오름차순). */
export function parseWorkOrderIds(order) {
  const ids = new Set();
  for (const item of Array.isArray(order?.lineItems) ? order.lineItems : []) {
    const m = typeof item?.memo === 'string' ? MEMO_RE.exec(item.memo.trim()) : null;
    if (m && m[1].length <= 15) ids.add(Number(m[1]));
  }
  return [...ids].sort((a, b) => a - b);
}

function activePayments(order) {
  if (!Array.isArray(order?.payments)) return null;
  return order.payments.filter((p) => p && typeof p === 'object' && p.state !== 'CANCELLED' && !p.cancelledAt);
}

/** 취소되지 않은 결제 금액의 합. payments 가 없으면 null(알 수 없음). */
export function remainingPaid(order) {
  const list = activePayments(order);
  if (list === null) return null;
  return list.reduce((sum, p) => sum + (Number.isInteger(p.amount) ? p.amount : 0), 0);
}

/**
 * 승인 처리용 금액. paid = 취소되지 않은 결제 합(0 이하면 웹훅의 amount),
 * unpaid = max(0, 청구액(chargePrice.totalAmount) - paid).
 */
export function computeAmounts(order, webhookAmount) {
  let paid = remainingPaid(order) ?? 0;
  if (paid <= 0 && Number.isInteger(webhookAmount)) paid = webhookAmount;
  const total = order?.chargePrice?.totalAmount;
  if (!Number.isInteger(total)) throw new TossApiError('주문 응답에 청구 금액이 없어요', false);
  const unpaid = Math.max(0, total - paid);
  return { paidValue: paid, unpaidValue: unpaid, fullyPaid: unpaid === 0 };
}
