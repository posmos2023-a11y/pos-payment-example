// 정비 전산과의 통신 프로토콜(WebSocket·HTTP 공통 메시지)의 플러그인 쪽 타입과 순수 함수들.
import type { DraftLike } from './sdk-types.ts';

export const OUR_KEY_PREFIX = 'gm-';

export type TransportKind = 'ws' | 'http';
export type LogLevel = 'info' | 'warn' | 'error';

// ---- 4.1 공통 타입 ----------------------------------------------------------

export interface CartLine {
  /** "gm-{workOrderId}-{lineId}" */
  key: string;
  productCode: string;
  title: string;
  category: string;
  unitPrice: number;
  quantity: number;
  taxFree: boolean;
}

export interface DraftSummaryLine {
  key: string;
  title: string;
  quantity: number;
  /** 단가(itemPrice.priceValue) */
  priceValue: number;
}

export interface DraftSummary {
  lineCount: number;
  totalQuantity: number;
  orderPriceValue: number;
  ourKeys: string[];
  workOrderIds: number[];
  lines: DraftSummaryLine[];
  updatedAt: string;
}

// ---- 4.2 서버 -> 플러그인 ---------------------------------------------------

export interface SyncCartPayload {
  workOrderId: number;
  label: string;
  lines: CartLine[];
  startPayment: boolean;
  exclusive: boolean;
}

export interface ClearCartPayload {
  scope: 'ours';
}

export interface Command {
  id: string;
  seq: number;
  kind: 'SYNC_CART' | 'CLEAR_CART';
  createdAt: string;
  payload: SyncCartPayload | ClearCartPayload;
}

export type ServerMessage =
  | { type: 'welcome'; serverVersion: string; serverTime: string }
  | { type: 'command'; command: Command }
  | { type: 'ping'; t: unknown }
  | { type: 'error'; code: string; message: string };

// ---- 4.3 플러그인 -> 서버 ---------------------------------------------------

export interface HelloMessage {
  type: 'hello';
  clientId: string;
  pluginName: string;
  pluginVersion: string;
  transport: TransportKind;
  processedIds: string[];
  /** 토스 merchantId(선택). 알 수 없으면 생략 */
  merchantId?: string;
}

export interface AckMessage {
  type: 'ack';
  commandId: string;
  ok: boolean;
  superseded?: boolean;
  error?: string;
  draft: DraftSummary | null;
}

export interface DraftMessage {
  type: 'draft';
  draft: DraftSummary;
}

export interface PaymentPaidMessage {
  type: 'payment.paid';
  paymentId: string;
  orderId: string;
  workOrderIds: number[];
  fullyPaid: boolean;
  paidValue: number;
  unpaidValue: number;
}

export interface PaymentCancelledMessage {
  type: 'payment.cancelled';
  paymentId: string;
  orderId: string;
}

export interface PongMessage {
  type: 'pong';
  t: unknown;
}

export interface LogMessage {
  type: 'log';
  level: LogLevel;
  message: string;
}

export type PluginMessage =
  | HelloMessage
  | AckMessage
  | DraftMessage
  | PaymentPaidMessage
  | PaymentCancelledMessage
  | PongMessage
  | LogMessage;

// ---- 키 유틸 ---------------------------------------------------------------

export function isOurKey(key: string): boolean {
  return key.startsWith(OUR_KEY_PREFIX);
}

// POS key = 논리 key + `_` + nonce(영숫자 8자). 논리 key(정비 전산 서버가 준 gm-{작업ID}-{라인ID})에는 `_` 가 없어야 한다.
// POS 는 같은 key 의 라인을 여러 개 허용하므로, 라인마다 새 POS key 를 발급해 옛 라인과 섞이지 않게 한다.
export const POS_NONCE_LENGTH = 8;
const POS_NONCE_TAIL_RE = /_[A-Za-z0-9]{8}$/;

/** 논리 key + nonce -> POS 에 담을 key. */
export function makePosKey(logical: string, rand: string): string {
  return `${logical}_${rand}`;
}

/**
 * POS key -> 논리 key. 우리 key(gm-)가 아니면 null.
 * 끝의 `_nonce`(영숫자 8자)를 뗀다. 꼬리가 없는 옛 key(gm-4-10)는 그대로 돌려준다.
 */
export function logicalKeyOf(posKey: string): string | null {
  if (!isOurKey(posKey)) return null;
  return posKey.replace(POS_NONCE_TAIL_RE, '');
}

/** "gm-12-34" -> 12. 우리 키가 아니면 null. */
export function parseWorkOrderId(key: string): number | null {
  const m = /^gm-(\d+)(?:-|$)/.exec(key);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) ? n : null;
}

// ---- 주문 항목 메모(결제된 주문에서 작업을 찾는 데 쓴다) -----------
//
// 메모는 POS 주문 화면에서 직원에게 보인다. 형식은 `#작업ID 라벨`(80자 제한, 비면 '').
// 만드는 함수(makeLineMemo)와 읽는 함수(parseLineMemo)가 형식을 아는 유일한 곳이다.
export const LINE_MEMO_MAX = 80;
const MEMO_RE = /^#(\d+)(\s|$)/;

export function makeLineMemo(workOrderId: number, label: string): string {
  const clean = label.replace(/\s+/g, ' ').trim();
  const memo = clean === '' ? `#${workOrderId}` : `#${workOrderId} ${clean}`;
  return [...memo].slice(0, LINE_MEMO_MAX).join('');
}

/** 주문 항목 메모 -> 작업 ID. 우리 형식이 아니면 null. */
export function parseLineMemo(memo: unknown): number | null {
  if (typeof memo !== 'string') return null;
  const m = MEMO_RE.exec(memo.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) ? n : null;
}

// ---- DraftSummary ----------------------------------------------------------

export const SUMMARY_MAX_LINES = 50;

/**
 * 임시 주문 -> DraftSummary.
 * keyMapReverse: POS 가 바꾼 key -> 우리 key. 보고할 때는 항상 우리 key 로 되돌려 쓴다.
 */
export function summarizeDraft(
  draft: DraftLike,
  keyMapReverse: ReadonlyMap<string, string>,
  updatedAt: string,
): DraftSummary {
  const lines: DraftSummaryLine[] = [];
  const ourKeys: string[] = [];
  const ids = new Set<number>();
  let totalQuantity = 0;
  for (const li of draft.lineItems) {
    // 보고는 항상 논리 key(gm-{작업ID}-{라인ID})로: keyMap(POS 가 바꾼 key) -> `_nonce` 뗀 key -> 그대로(우리 key 아님)
    const key = keyMapReverse.get(li.key) ?? logicalKeyOf(li.key) ?? li.key;
    totalQuantity += li.quantity;
    if (isOurKey(key)) {
      ourKeys.push(key);
      const id = parseWorkOrderId(key);
      if (id !== null) ids.add(id);
    }
    if (lines.length < SUMMARY_MAX_LINES) {
      lines.push({
        key,
        title: li.item.title,
        quantity: li.quantity,
        priceValue: li.itemPrice.priceValue,
      });
    }
  }
  return {
    lineCount: draft.lineItems.length,
    totalQuantity,
    orderPriceValue: draft.price.orderPriceValue,
    ourKeys,
    workOrderIds: [...ids].sort((a, b) => a - b),
    lines,
    updatedAt,
  };
}

/** updatedAt 을 뺀 내용 서명. 변경 감지용. */
export function summarySignature(s: DraftSummary): string {
  return JSON.stringify([
    s.lineCount,
    s.totalQuantity,
    s.orderPriceValue,
    s.ourKeys,
    s.workOrderIds,
    s.lines,
  ]);
}

// ---- 송신 버퍼 -------------------------------------------------------------

export function isPriorityMessage(msg: PluginMessage): boolean {
  return msg.type === 'ack' || msg.type === 'payment.paid' || msg.type === 'payment.cancelled';
}

/** 큐 정리: draft 는 마지막 것만 남기고, max 를 넘으면 우선순위 낮은(ack/payment.* 가 아닌) 오래된 것부터 버린다. */
export function trimOutgoing(queue: PluginMessage[], max: number): void {
  let lastDraft = -1;
  for (let i = queue.length - 1; i >= 0; i--) {
    if (queue[i]!.type === 'draft') {
      lastDraft = i;
      break;
    }
  }
  if (lastDraft >= 0) {
    for (let i = lastDraft - 1; i >= 0; i--) {
      if (queue[i]!.type === 'draft') queue.splice(i, 1);
    }
  }
  while (queue.length > max) {
    const idx = queue.findIndex((m) => !isPriorityMessage(m));
    queue.splice(idx >= 0 ? idx : 0, 1);
  }
}

export function enqueueOutgoing(queue: PluginMessage[], msg: PluginMessage, max: number): void {
  queue.push(msg);
  trimOutgoing(queue, max);
}

// ---- 서버 메시지 파싱 ------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 이미 JSON.parse 된 값을 ServerMessage 로 정리. 알 수 없으면 null. */
export function coerceServerMessage(value: unknown): ServerMessage | null {
  if (!isRecord(value) || typeof value.type !== 'string') return null;
  switch (value.type) {
    case 'welcome':
      return {
        type: 'welcome',
        serverVersion: typeof value.serverVersion === 'string' ? value.serverVersion : '',
        serverTime: typeof value.serverTime === 'string' ? value.serverTime : '',
      };
    case 'command': {
      const c = coerceCommand(value.command);
      return c ? { type: 'command', command: c } : null;
    }
    case 'ping':
      return { type: 'ping', t: value.t };
    case 'error':
      return {
        type: 'error',
        code: typeof value.code === 'string' ? value.code : 'UNKNOWN',
        message: typeof value.message === 'string' ? value.message : '',
      };
    default:
      return null;
  }
}

/** Command 의 겉모양만 확인한다(payload 의 세부 검증은 bridge 가 명령 처리 시 한다). */
export function coerceCommand(value: unknown): Command | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== 'string' || value.id === '') return null;
  if (typeof value.kind !== 'string') return null;
  return {
    id: value.id,
    seq: typeof value.seq === 'number' ? value.seq : 0,
    kind: value.kind as Command['kind'],
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : '',
    payload: (isRecord(value.payload) ? value.payload : {}) as unknown as Command['payload'],
  };
}

export function parseServerMessage(text: string): ServerMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  return coerceServerMessage(value);
}

// ---- SYNC_CART 페이로드 검증 -----------------------------------------------

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

export function parseSyncCartPayload(payload: unknown): ParseResult<SyncCartPayload> {
  if (!isRecord(payload)) return { ok: false, error: '잘못된 명령: payload 가 없어요' };
  const workOrderId = payload.workOrderId;
  if (typeof workOrderId !== 'number' || !Number.isInteger(workOrderId)) {
    return { ok: false, error: '잘못된 명령: workOrderId' };
  }
  if (!Array.isArray(payload.lines)) return { ok: false, error: '잘못된 명령: lines' };
  const lines: CartLine[] = [];
  const seen = new Set<string>();
  for (const raw of payload.lines as unknown[]) {
    if (!isRecord(raw)) return { ok: false, error: '잘못된 명령: 라인 형식' };
    const key = raw.key;
    if (typeof key !== 'string' || !isOurKey(key)) {
      return { ok: false, error: `잘못된 명령: 라인 key (${String(key)})` };
    }
    // `_` 는 POS key 의 nonce 구분자라 논리 key 에 쓸 수 없다.
    if (key.includes('_')) return { ok: false, error: `잘못된 명령: 라인 key 에 _ 를 쓸 수 없어요 (${key})` };
    if (seen.has(key)) return { ok: false, error: `잘못된 명령: 중복된 라인 key (${key})` };
    seen.add(key);
    const quantity = raw.quantity;
    if (typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity < 1) {
      return { ok: false, error: `잘못된 명령: 수량 (${key})` };
    }
    const unitPrice = raw.unitPrice;
    if (typeof unitPrice !== 'number' || !Number.isFinite(unitPrice) || unitPrice < 0) {
      return { ok: false, error: `잘못된 명령: 단가 (${key})` };
    }
    const productCode = typeof raw.productCode === 'string' ? raw.productCode : '';
    const title =
      typeof raw.title === 'string' && raw.title !== '' ? raw.title : productCode || '정비 상품';
    lines.push({
      key,
      productCode,
      title,
      category: typeof raw.category === 'string' ? raw.category : '',
      unitPrice: Math.round(unitPrice),
      quantity,
      taxFree: raw.taxFree === true,
    });
  }
  return {
    ok: true,
    value: {
      workOrderId,
      label: typeof payload.label === 'string' ? payload.label : '',
      lines,
      startPayment: payload.startPayment === true,
      exclusive: payload.exclusive !== false,
    },
  };
}

export function parseClearCartPayload(payload: unknown): ParseResult<ClearCartPayload> {
  if (isRecord(payload) && payload.scope === 'ours') return { ok: true, value: { scope: 'ours' } };
  return { ok: false, error: '잘못된 명령: CLEAR_CART scope' };
}
