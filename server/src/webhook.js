// 토스 결제 웹훅 이벤트 처리. 서버는 서명을 검증하고 바로 200 을 준 뒤 이 처리기를 비동기로 부른다.
//
// 승인: Open API 로 주문을 조회해 항목 메모(#작업ID)에서 작업을 찾고 결제 반영 규칙(payments.js)으로 넘긴다.
//       메모가 없으면 주문 데이터 반영이 늦을 수 있어 memoRecheckMs 뒤에 한 번만 다시 조회한다.
//       Open API 키가 없으면 승인은 처리하지 않고 경고만 남긴다.
//       POS 플러그인의 payment.paid 도 Open API 키가 있으면 같은 경로(posPaid)로 확인한 뒤에 반영한다.
// 취소: 주문을 다시 조회해 남은 결제 합이 0 이면 취소(환불), 아니면 확인 필요. 키가 없으면 ID 만으로 취소 처리.
import { EVT_APPROVED, EVT_CANCELLED, TossApiError, computeAmounts, parseWorkOrderIds, remainingPaid } from './toss.js';

const text = (v) => (typeof v === 'string' || Number.isInteger(v) ? String(v).trim() : '');

export class TossWebhookProcessor {
  constructor({ store, payments, toss, memoRecheckMs = 30_000, retryDelaysMs = [30_000, 300_000, 1_800_000] }) {
    this.store = store;
    this.payments = payments;
    this.toss = toss;
    this.memoRecheckMs = memoRecheckMs;
    this.retryDelaysMs = retryDelaysMs;
    this.timers = new Set();
    this.pending = new Set(); // 진행 중인 처리(테스트에서 끝나기를 기다릴 때 쓴다)
  }

  /** 검증된 웹훅 본문을 처리한다. 기다리지 않고 바로 돌아온다. */
  handle(body) {
    const job = this.#parse(body);
    if (job) this.#start(job, 0, false);
  }

  /**
   * POS 플러그인이 보낸 payment.paid 를 토스에서 확인해 반영한다(Open API 키가 있을 때 server.js 가 부른다).
   * 단말이 보낸 금액·작업 번호·전액 결제 여부는 쓰지 않는다. 결제 ID·주문 ID 로 주문을 조회해 승인 웹훅과
   * 같은 방식(주문의 결제 합, 항목 메모의 #작업ID)으로 반영하므로, 매장 토큰만으로는 결제완료를 만들 수 없다.
   */
  posPaid(shop, msg) {
    const paymentId = text(msg?.paymentId).slice(0, 100);
    const orderId = text(msg?.orderId).slice(0, 100);
    if (!paymentId || !orderId) {
      this.store.addEvent('warn', 'payment.paid 형식 오류(paymentId, orderId)', shop.id);
      return;
    }
    if (this.store.seenRank(`${shop.id}|paid|${paymentId}`) >= 2) return; // 이미 토스로 확인해 처리한 결제(플러그인의 재전송)
    if (!shop.merchantId) {
      this.store.addEvent('warn', `결제 ${paymentId}: 가맹점 ID 를 몰라 토스에서 확인하지 못했어요 (플러그인이 hello 로 merchantId 를 알려야 해요)`, shop.id);
      return;
    }
    this.#start({ kind: 'approved', source: 'pos-verified', shopId: shop.id, merchantId: shop.merchantId, paymentId, orderId, amount: null }, 0, false);
  }

  /** 진행 중인 처리가 모두 끝날 때까지 기다린다(타이머로 미룬 재시도는 기다리지 않는다). */
  async idle() {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }

  close() {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  #parse(body) {
    const kind = body?.type === EVT_APPROVED ? 'approved' : body?.type === EVT_CANCELLED ? 'cancelled' : null;
    if (!kind) return null; // 다른 이벤트는 무시
    const p = body.data?.payment ?? {};
    const job = {
      kind,
      source: 'toss-webhook',
      merchantId: text(p.merchantId) || text(body.merchantId),
      paymentId: text(p.id),
      orderId: text(p.orderId),
      amount: Number.isInteger(p.amount) && p.amount >= 0 ? p.amount : null,
    };
    if (!job.merchantId || !job.paymentId || !job.orderId) {
      this.store.addEvent('warn', '웹훅에 merchantId/결제 ID/주문 ID 가 없어 처리하지 않아요');
      return null;
    }
    return job;
  }

  #start(job, attempt, memoRechecked) {
    const run = this.#run(job, attempt, memoRechecked)
      .catch((err) => this.store.addEvent('error', `웹훅 처리 오류: ${err instanceof Error ? err.message : 'unknown'}`))
      .finally(() => this.pending.delete(run));
    this.pending.add(run);
  }

  #later(ms, job, attempt, memoRechecked) {
    const t = setTimeout(() => {
      this.timers.delete(t);
      this.#start(job, attempt, memoRechecked);
    }, ms);
    t.unref();
    this.timers.add(t);
  }

  async #run(job, attempt, memoRechecked) {
    // 단말 보고를 확인하는 경우(shopId 있음)는 그 단말의 매장, 웹훅은 가맹점 ID 로 매장을 찾는다.
    const shop = job.shopId ? this.store.shops.get(job.shopId) : this.store.shopByMerchant(job.merchantId);
    if (!shop) {
      this.store.addEvent('warn', `웹훅: 가맹점 ${job.merchantId} 에 연결된 매장이 없어요 (플러그인이 hello 로 merchantId 를 알려야 해요)`);
      return;
    }
    if (job.kind === 'approved') await this.#approved(shop, job, attempt, memoRechecked);
    else await this.#cancelled(shop, job, attempt);
  }

  async #approved(shop, job, attempt, memoRechecked) {
    const { store, toss } = this;
    if (!toss.configured) {
      store.addEvent('warn', '토스 Open API 키가 설정되지 않아 결제 승인 웹훅을 처리하지 않았어요', shop.id);
      return;
    }
    let order;
    try {
      order = await toss.getOrder(job.merchantId, job.orderId);
    } catch (err) {
      if (!(err instanceof TossApiError)) throw err;
      if (err.retryable && attempt < this.retryDelaysMs.length) {
        this.#later(this.retryDelaysMs[attempt], job, attempt + 1, memoRechecked);
      } else {
        store.addEvent('error', `주문 조회 실패(결제 ${job.paymentId}): ${err.message}`, shop.id);
      }
      return;
    }
    const ids = parseWorkOrderIds(order);
    if (ids.length === 0) {
      if (!memoRechecked) {
        this.#later(this.memoRecheckMs, job, attempt, true);
      } else {
        store.markSeen(`${shop.id}|paid|${job.paymentId}`, 2); // 확인이 끝난 결제: 플러그인이 다시 보내도 또 조회하지 않는다
        store.addEvent('info', `결제 ${job.paymentId}: 주문에 정비 작업 메모(#작업ID)가 없어 무시했어요`, shop.id);
      }
      return;
    }
    let amounts;
    try {
      amounts = computeAmounts(order, job.amount);
    } catch (err) {
      store.addEvent('error', `주문 금액 해석 실패(결제 ${job.paymentId}): ${err.message}`, shop.id);
      return;
    }
    this.payments.paid(shop.id, {
      paymentId: job.paymentId, orderId: job.orderId, workOrderIds: ids, ...amounts, source: job.source,
    });
  }

  async #cancelled(shop, job, attempt) {
    const { store, toss } = this;
    let fullCancel = true; // 키가 없으면 조회할 수 없으니 ID 로만 처리
    let ids = [];
    if (toss.configured) {
      try {
        const order = await toss.getOrder(job.merchantId, job.orderId);
        fullCancel = remainingPaid(order) === 0;
        ids = parseWorkOrderIds(order);
      } catch (err) {
        if (!(err instanceof TossApiError)) throw err;
        if (err.retryable && attempt < this.retryDelaysMs.length) {
          this.#later(this.retryDelaysMs[attempt], job, attempt + 1, false);
          return;
        }
        store.addEvent('error', `주문 조회 실패(취소 ${job.paymentId}): ${err.message}`, shop.id);
        fullCancel = false; // 확인하지 못했으니 환불로 단정하지 않는다
      }
    }
    this.payments.cancelled(shop.id, {
      paymentId: job.paymentId, orderId: job.orderId, source: 'toss-webhook', fullCancel, extraWorkOrderIds: ids,
    });
  }
}
