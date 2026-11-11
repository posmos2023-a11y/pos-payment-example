// 결제 반영 규칙. POS 플러그인의 payment.* 메시지와 토스 웹훅이 같은 함수를 부른다.
//
// 규칙 요약
//  - 같은 (종류, paymentId) 는 출처 등급마다 한 번만 반영한다. 단말이 보낸 값 그대로(source 'pos')는 1등급,
//    토스로 확인한 값(웹훅 'toss-webhook', 단말 보고를 주문 조회로 확인한 'pos-verified')은 2등급이다.
//    단말이 작업 번호나 금액 없이 먼저 보고했더라도, 같은 결제의 2등급 결과가 한 번은 바로잡을 수 있다.
//  - 이미 취소가 처리된 paymentId 의 paid 는 반영하지 않는다(승인 처리가 늦어져 취소보다 뒤에 온 경우).
//  - paid: workOrderIds 가 비면 기록만. 이미 결제완료인 작업에 온 paid 는 무시.
//          fullyPaid 이고 paidValue 가 작업 합계와 같으면 결제완료, 금액이 다르면 확인 필요,
//          fullyPaid 가 아닌데 unpaidValue < 0 이면 확인 필요, 그 밖의 부분 결제는 기록만.
//  - cancelled: paymentId 로 작업을 찾고 없으면 orderId 로 찾아 결제완료였던 작업을 취소(환불)로.
import { WO } from './store.js';

const isInt = (v) => Number.isInteger(v);
const text = (v) => (typeof v === 'string' ? v.trim().slice(0, 100) : '');
/** 출처 등급: 단말이 보낸 값 그대로는 1, 토스로 확인한 값은 2. */
const rankOf = (source) => (source === 'pos' ? 1 : 2);

export function cleanIds(raw) {
  const out = new Set();
  for (const v of Array.isArray(raw) ? raw : []) if (isInt(v) && v > 0) out.add(v);
  return [...out].sort((a, b) => a - b);
}

export class Payments {
  constructor(store) {
    this.store = store;
  }

  /** POS 플러그인의 payment.paid 메시지. */
  paidFromPos(shopId, msg) {
    const paymentId = text(msg.paymentId);
    if (!paymentId || !isInt(msg.paidValue) || msg.paidValue < 0) {
      this.store.addEvent('warn', 'payment.paid 형식 오류(paymentId, paidValue)', shopId);
      return 'invalid';
    }
    return this.paid(shopId, {
      paymentId,
      orderId: text(msg.orderId),
      workOrderIds: cleanIds(msg.workOrderIds),
      fullyPaid: msg.fullyPaid === true,
      paidValue: msg.paidValue,
      unpaidValue: isInt(msg.unpaidValue) ? msg.unpaidValue : -1, // 숫자가 아니면 "결제액을 알 수 없음"
      source: 'pos',
    });
  }

  /** POS 플러그인의 payment.cancelled 메시지. */
  cancelledFromPos(shopId, msg) {
    const paymentId = text(msg.paymentId);
    if (!paymentId) {
      this.store.addEvent('warn', 'payment.cancelled 형식 오류(paymentId)', shopId);
      return 'invalid';
    }
    return this.cancelled(shopId, { paymentId, orderId: text(msg.orderId), source: 'pos' });
  }

  /** 반환: 'invalid' | 'duplicate' | 'recorded'(기록만) | 'ignored'(이미 결제완료이거나 이미 취소된 결제) | 'done' */
  paid(shopId, { paymentId, orderId, workOrderIds, fullyPaid, paidValue, unpaidValue, source }) {
    const { store } = this;
    // 플러그인은 재연결마다 다시 보낸다. 같은 등급(또는 더 낮은 등급)의 되풀이만 버린다.
    if (!store.markSeen(`${shopId}|paid|${paymentId}`, rankOf(source))) return 'duplicate';
    if (store.seenRank(`${shopId}|cancelled|${paymentId}`) > 0) {
      store.addEvent('warn', `결제 ${paymentId}: 이미 취소가 처리된 결제라 반영하지 않았어요 (${source})`, shopId);
      return 'ignored';
    }
    const all = workOrderIds
      .map((id) => store.workOrders.get(id))
      .filter((wo) => wo && wo.shopId === shopId); // 다른 매장의 작업 번호는 버린다
    if (all.length === 0) {
      store.addEvent('info', `결제 ${paymentId}: 연결된 작업이 없어 기록만 했어요 (${source})`, shopId);
      return 'recorded';
    }
    const targets = all.filter((wo) => wo.status !== WO.PAID);
    if (targets.length === 0) {
      store.addEvent('info', `결제 ${paymentId}: 이미 결제완료인 작업이라 무시했어요 (${source})`, shopId);
      return 'ignored';
    }
    const expected = targets.reduce((sum, wo) => sum + store.total(wo), 0);
    const ids = targets.map((wo) => `#${wo.id}`).join(', ');

    if (fullyPaid && paidValue === expected) {
      for (const wo of targets) {
        Object.assign(wo, { status: WO.PAID, reviewReason: '', paymentId, orderId, paidAmount: paidValue });
        store.supersedePending(wo.id); // 결제가 끝난 작업에는 더 이상 [담기] 명령을 보내지 않는다
      }
      store.addEvent('info', `결제완료: 작업 ${ids} ${paidValue.toLocaleString('ko-KR')}원 (${source})`, shopId);
      return 'done';
    }
    let reason = null;
    if (fullyPaid) {
      reason = `금액 확인 필요: 결제 ${paidValue}원, 작업 합계 ${expected}원`;
    } else if (unpaidValue < 0) {
      reason = '결제 확인 필요: 플러그인이 결제 금액을 조회하지 못했어요';
    }
    if (reason === null) {
      store.addEvent('info', `부분 결제 기록: 작업 ${ids} 결제 ${paidValue}원, 남은 금액 ${unpaidValue}원`, shopId);
      return 'recorded';
    }
    for (const wo of targets) Object.assign(wo, { status: WO.REVIEW, reviewReason: reason, paymentId, orderId, paidAmount: paidValue });
    store.addEvent('warn', `확인 필요: 작업 ${ids} - ${reason} (${source})`, shopId);
    return 'done';
  }

  /**
   * 결제 취소. fullCancel=false 이면 "일부만 취소됐거나 확인 못 함"이라 결제완료 작업을 확인 필요로 돌린다.
   * extraWorkOrderIds: 주문 조회로 알아낸 작업 번호(웹훅 경로).
   */
  cancelled(shopId, { paymentId, orderId, source, fullCancel = true, extraWorkOrderIds = [] }) {
    const { store } = this;
    if (!store.markSeen(`${shopId}|cancelled|${paymentId}`, rankOf(source))) return 'duplicate';
    const mine = [...store.workOrders.values()].filter((wo) => wo.shopId === shopId);
    let targets = mine.filter((wo) => wo.paymentId === paymentId);
    if (targets.length === 0 && orderId) targets = mine.filter((wo) => wo.orderId === orderId);
    for (const id of extraWorkOrderIds) {
      const wo = store.workOrders.get(id);
      if (wo && wo.shopId === shopId && !targets.includes(wo)) targets.push(wo);
    }
    targets = targets.filter((wo) => wo.status === WO.PAID || wo.status === WO.REVIEW);
    if (targets.length === 0) {
      store.addEvent('info', `결제취소 ${paymentId}: 반영할 작업이 없어 기록만 했어요 (${source})`, shopId);
      return 'recorded';
    }
    for (const wo of targets) {
      if (wo.status === WO.REVIEW) {
        if (fullCancel) Object.assign(wo, { status: WO.PENDING, reviewReason: '' }); // 보류 중이던 경고만 해제
      } else if (fullCancel) {
        wo.status = WO.REFUNDED;
      } else {
        Object.assign(wo, { status: WO.REVIEW, reviewReason: '결제 취소 확인 필요: 남은 결제 금액을 확인하세요' });
      }
    }
    const ids = targets.map((wo) => `#${wo.id}`).join(', ');
    store.addEvent(fullCancel ? 'info' : 'warn', `결제취소 ${fullCancel ? '반영(환불)' : '확인 필요'}: 작업 ${ids} (${source})`, shopId);
    return 'done';
  }

  /** 직원이 [결제완료로 처리] 를 눌렀을 때(확인 필요 작업 전용). */
  confirmPaid(wo) {
    wo.status = WO.PAID;
    wo.reviewReason = '';
    this.store.supersedePending(wo.id);
    this.store.addEvent('info', `직원이 작업 #${wo.id} 를 결제완료로 처리했어요`, wo.shopId);
  }
}
