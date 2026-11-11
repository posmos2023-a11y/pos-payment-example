import { useState } from 'react';
import { describeError } from '../lib/errors.ts';
import { normalizeUrlInput, saveSettings, validateServerUrl } from '../lib/settings-store.ts';
import type { AppSettings } from '../lib/settings-store.ts';
import { useBridgeView } from '../lib/use-bridge-view.ts';
import type { PaymentRuntime } from '../payment/runtime.ts';
import type { Services } from '../sdk-types.ts';
import { connectionText } from './Payment.tsx';

interface Props {
  services: Services;
  runtime: PaymentRuntime;
  settings: AppSettings;
  onSaved: (s: AppSettings) => void;
}

export function Settings({ services, runtime, settings, onSaved }: Props) {
  const [v, setV] = useState<AppSettings>(settings);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const view = useBridgeView(runtime.bridge);

  const patch = (p: Partial<AppSettings>) => setV((cur) => ({ ...cur, ...p }));

  const save = async () => {
    const serverUrl = normalizeUrlInput(v.serverUrl);
    const problem = validateServerUrl(serverUrl);
    setError(problem);
    if (problem) return;
    setSaving(true);
    try {
      const next: AppSettings = { ...v, serverUrl, token: v.token.trim(), defaultItemCode: v.defaultItemCode.trim() };
      await saveSettings(services.storage, services.secureStore, next);
      setV(next);
      onSaved(next);
      await runtime.applySettings(); // 시작·중지·설정 다시 읽기를 알아서 고른다(브리지 reloadSettings)
      services.toast.success('설정을 저장했어요');
    } catch (e) {
      services.toast.error(`설정을 저장하지 못했어요: ${describeError(e)}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section>
      <h2>정비 전산 연결</h2>
      <div className="card pad">
        <label className="field">
          <span>정비 전산 서버 주소</span>
          <input
            type="url"
            placeholder="https://서버주소"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            value={v.serverUrl}
            onChange={(e) => patch({ serverUrl: e.target.value })}
          />
          <small className="muted">https:// 주소를 쓰세요. 앞부분을 빼면 https:// 를 붙여요(이 PC·내부망 주소에만 http://). http:// 는 로컬 시험용이에요</small>
        </label>
        <label className="field">
          <span>매장 토큰</span>
          <input
            type="password"
            placeholder="정비 전산에서 받은 매장 토큰"
            autoComplete="off"
            value={v.token}
            onChange={(e) => patch({ token: e.target.value })}
          />
          <small className="muted">이 기기에 암호화해서 저장해요</small>
        </label>
      </div>

      <h2>결제 연동</h2>
      <div className="card pad">
        <label className="check">
          <input
            type="checkbox"
            checked={v.allowStartPayment}
            onChange={(e) => patch({ allowStartPayment: e.target.checked })}
          />
          <span>담으면 바로 결제 화면 열기</span>
        </label>
        <label className="check">
          <input type="checkbox" checked={v.matchCatalog} onChange={(e) => patch({ matchCatalog: e.target.checked })} />
          <span>POS 상품코드 매칭</span>
        </label>
        <label className="field">
          <span>기본 상품 코드(선택)</span>
          <input
            type="text"
            placeholder="POS 에 만들어 둔 '정비' 상품의 코드"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            value={v.defaultItemCode}
            onChange={(e) => patch({ defaultItemCode: e.target.value })}
          />
          <small className="muted">상품코드가 맞는 POS 상품이 없을 때 이 상품을 밑판으로 써요. 없으면 판매 중 첫 상품을 써요</small>
        </label>
        <label className="check">
          <input type="checkbox" checked={v.showToast} onChange={(e) => patch({ showToast: e.target.checked })} />
          <span>알림 표시</span>
        </label>
        {error && <p className="notice error">{error}</p>}
        <div className="actions">
          <button type="button" className="btn primary" disabled={saving} onClick={() => void save()}>
            저장
          </button>
        </div>
      </div>

      <div className="card pad">
        <p>
          <strong>연결 확인</strong>
        </p>
        <p className={view.welcomed ? '' : 'bad'}>
          {view.welcomed ? '● 정비 전산이 응답했어요(welcome 수신)' : `○ 아직 응답이 없어요 — ${connectionText(view)}`}
        </p>
      </div>
    </section>
  );
}
