// 탭을 다시 열 때 놓친 결제 찾기.
// 탭이 닫혀 있는 동안 끝난 결제를 최근 주문 조회(order.getOrders)로 찾아 정비 전산 서버에 알린다.
// 이 파일은 순수 로직이다: SDK·저장소·전송은 deps 로 받는다(bridge 가 채운다).
import type { PaymentCancelledMessage, PaymentPaidMessage } from './protocol.ts';
import { parseLineMemo } from './protocol.ts';
import type { OrderDetailLike } from './sdk-types.ts';
import type { PaywatchEntry } from './paywatch.ts';

export const RECONCILE_LOOKBACK_MS = 2 * 60_000;
export const RECONCILE_PAGE_SIZE = 50;
export const RECONCILE_RETRY_MS = 15_000;

export interface ReconcileDeps {
  /** 현재 결제 대기 기록 */
  paywatch(): PaywatchEntry[];
  /** 호출 제한 오류인지 */
  isRateLimit(e: unknown): boolean;
  getOrders(params: { start: string; end: string; size: number }): Promise<OrderDetailLike[]>;
  sleep(ms: number): Promise<void>;
  now(): number;
  /** 이미 정비 전산 서버로 보낸(또는 보내는 중인) 결제인지 */
  alreadySentPaid(paymentId: string): boolean;
  alreadySentCancelled(paymentId: string): boolean;
  /** bridge.sendPayment: 보존·전송 규칙을 공유한다 */
  send(msg: PaymentPaidMessage | PaymentCancelledMessage): void;
  /** 처리한 작업의 결제 대기 기록을 지운다 */
  clearPaywatch(workOrderIds: number[]): Promise<void>;
  log(level: 'info' | 'warn', message: string): void;
  isStopped(): boolean;
}

export interface ReconcileResult {
  /** getOrders 를 호출했는지(paywatch 가 비면 false) */
  ran: boolean;
  paid: number;
  cancelled: number;
  error?: string;
}

/** 주문의 항목 메모에서 우리 작업 ID 를 모은다(없으면 우리 주문이 아님). */
export function workOrderIdsOf(order: { lineItems?: { memo?: string }[] }): number[] {
  const ids = new Set<number>();
  for (const li of order.lineItems ?? []) {
    const id = parseLineMemo(li.memo);
    if (id !== null) ids.add(id);
  }
  return [...ids].sort((a, b) => a - b);
}

export async function reconcilePayments(deps: ReconcileDeps): Promise<ReconcileResult> {
  const watch = deps.paywatch();
  if (watch.length === 0) return { ran: false, paid: 0, cancelled: 0 };

  const oldest = Math.min(...watch.map((e) => Date.parse(e.at)));
  const now = deps.now();
  const params = {
    start: new Date(oldest - RECONCILE_LOOKBACK_MS).toISOString(),
    end: new Date(now).toISOString(),
    size: RECONCILE_PAGE_SIZE,
  };

  let orders: OrderDetailLike[];
  try {
    try {
      orders = await deps.getOrders(params);
    } catch (e) {
      if (!deps.isRateLimit(e) || deps.isStopped()) throw e;
      deps.log('warn', `최근 주문 조회가 호출 제한에 걸렸어요. ${RECONCILE_RETRY_MS / 1000}초 후 한 번 더 시도해요`);
      await deps.sleep(RECONCILE_RETRY_MS);
      if (deps.isStopped()) return { ran: true, paid: 0, cancelled: 0, error: '중단됐어요' };
      orders = await deps.getOrders(params);
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    deps.log('warn', `최근 주문을 조회하지 못했어요: ${message}`);
    return { ran: true, paid: 0, cancelled: 0, error: message };
  }

  let paid = 0;
  let cancelled = 0;
  let warnedBad = false;
  for (const order of Array.isArray(orders) ? orders : []) {
    const workOrderIds = workOrderIdsOf(order);
    if (workOrderIds.length === 0) continue;
    const state = order.paymentState;
    if (state === 'PAID' || state === 'COMPLETED') {
      const price = order.paymentPrice as unknown;
      const pp = price !== null && typeof price === 'object' ? (price as Record<string, unknown>) : null;
      if (
        pp === null ||
        typeof pp.paymentUnpaidValue !== 'number' ||
        typeof pp.paymentPaidValue !== 'number' ||
        !Array.isArray(order.payments)
      ) {
        if (!warnedBad) {
          warnedBad = true;
          deps.log('warn', '결제 금액 정보나 결제 목록이 없는 주문은 건너뛰어요');
        }
        continue;
      }
      const unpaid = order.paymentPrice.paymentUnpaidValue;
      const fullyPaid = unpaid === 0;
      for (const p of order.payments) {
        if (deps.alreadySentPaid(p.id)) continue;
        deps.send({
          type: 'payment.paid',
          paymentId: p.id,
          orderId: order.id,
          workOrderIds,
          fullyPaid,
          paidValue: order.paymentPrice.paymentPaidValue,
          unpaidValue: unpaid,
        });
        paid++;
      }
      if (fullyPaid) await deps.clearPaywatch(workOrderIds);
    } else if (state === 'REFUNDED' || state === 'CANCELLED') {
      if (!Array.isArray(order.payments)) {
        if (!warnedBad) {
          warnedBad = true;
          deps.log('warn', '결제 목록이 없는 주문은 건너뛰어요');
        }
        continue;
      }
      for (const p of order.payments) {
        if (deps.alreadySentCancelled(p.id)) continue;
        deps.send({ type: 'payment.cancelled', paymentId: p.id, orderId: order.id });
        cancelled++;
      }
      await deps.clearPaywatch(workOrderIds);
    }
  }
  if (paid + cancelled > 0) deps.log('info', `놓친 결제 ${paid + cancelled}건을 찾아 전산에 알렸어요`);
  return { ran: true, paid, cancelled };
}
