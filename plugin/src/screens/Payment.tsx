import { useState } from 'react';
import { describeError } from '../lib/errors.ts';
import { formatTime, formatWon } from '../lib/format.ts';
import { useBridgeView } from '../lib/use-bridge-view.ts';
import { ACTIVITY_TEXT } from '../payment/activity.ts';
import type { PaymentRuntime } from '../payment/runtime.ts';
import type { ToastLike } from '../sdk-types.ts';

interface Props {
  runtime: PaymentRuntime;
  toast: ToastLike;
  /** 서버 주소와 매장 토큰이 모두 설정돼 있는지. 없으면 결제 연동을 시작하지 않는다 */
  configured: boolean;
}

export function connectionText(view: { online: boolean; transport: 'ws' | 'http' | null; issue: string | null }): string {
  if (view.online) return `● 연결됨 · ${view.transport === 'http' ? 'HTTP 폴링' : 'WebSocket'}`;
  return `○ 연결 안 됨${view.issue ? ` (${view.issue})` : ''}`;
}

export function Payment({ runtime, toast, configured }: Props) {
  const view = useBridgeView(runtime.bridge);
  const [opening, setOpening] = useState(false);

  const openPayment = async () => {
    setOpening(true);
    try {
      await runtime.bridge.openPayment();
    } catch (e) {
      toast.error(`결제 화면을 열지 못했어요: ${describeError(e)}`);
    } finally {
      setOpening(false);
    }
  };

  return (
    <section>
      <p className="notice">
        이 화면이 열려 있어야 정비 전산에서 [담기]한 상품이 POS에 들어와요. 결제를 마치면 다시 이 탭을 열어 주세요.
      </p>

      {!configured && <p className="notice error">설정에서 서버 주소와 매장 토큰을 넣어 주세요</p>}

      <div className="card pad">
        <p>
          결제 연동 <strong className={view.online ? '' : 'bad'}>{connectionText(view)}</strong>
        </p>
      </div>

      <h2>지금 POS 장바구니의 정비 항목</h2>
      {view.cart.length === 0 ? (
        <p className="muted center">정비 전산에서 담은 항목이 없어요</p>
      ) : (
        <>
          <ul className="list">
            {view.cart.map((w) => (
              <li key={w.workOrderId} className="card pad">
                <p>
                  <strong>작업 #{w.workOrderId}</strong> {w.label}
                </p>
                <ul className="facts">
                  {w.lines.map((l, i) => (
                    <li key={i}>
                      {l.title} × {l.quantity} · {formatWon(l.priceValue * l.quantity)}
                    </li>
                  ))}
                </ul>
                <p className="small muted">작업 합계 {formatWon(w.total)}</p>
              </li>
            ))}
          </ul>
          <p className="right">
            <strong>합계 {formatWon(view.cartTotal)}</strong>
          </p>
        </>
      )}
      <div className="actions">
        <button
          type="button"
          className="btn primary"
          disabled={opening || view.cart.length === 0}
          onClick={() => void openPayment()}
        >
          결제 화면 열기
        </button>
      </div>

      <h2>최근 처리 내역</h2>
      {view.activity.length === 0 ? (
        <p className="muted center">아직 처리한 내역이 없어요</p>
      ) : (
        <ul className="list">
          {[...view.activity].reverse().map((a, i) => (
            <li key={`${a.at}-${i}`} className="card pad">
              <p className="small muted">{formatTime(a.at)}</p>
              <p>
                {a.label || '정비 전산'} · {ACTIVITY_TEXT[a.result]}
                {a.detail ? <span className="bad small"> {a.detail}</span> : null}
              </p>
            </li>
          ))}
        </ul>
      )}

      <h2>최근 결제 알림</h2>
      {view.payments.length === 0 ? (
        <p className="muted center">전산에 알린 결제가 없어요</p>
      ) : (
        <ul className="list">
          {view.payments.map((p) => (
            <li key={`${p.type}-${p.paymentId}`} className="card pad">
              <p className="small muted">{formatTime(new Date(p.at).toISOString())}</p>
              <p>
                {p.type === 'payment.paid' ? `결제 ${p.amount !== null ? formatWon(p.amount) : ''}` : '결제 취소'}
                {p.workOrderIds.length > 0 ? ` · 작업 ${p.workOrderIds.map((id) => `#${id}`).join(', ')}` : ''}
                {' · '}
                <span className={p.sent ? '' : 'bad'}>{p.sent ? '보냄' : '대기'}</span>
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
