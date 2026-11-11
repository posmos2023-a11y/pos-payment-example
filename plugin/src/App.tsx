import { useEffect, useState } from 'react';
import { DEFAULT_SETTINGS, isConfigured, loadSettings } from './lib/settings-store.ts';
import type { AppSettings } from './lib/settings-store.ts';
import type { PaymentRuntime } from './payment/runtime.ts';
import type { Services } from './sdk-types.ts';
import { Payment } from './screens/Payment.tsx';
import { Settings } from './screens/Settings.tsx';

type Tab = 'payment' | 'settings';

const TABS: { id: Tab; label: string }[] = [
  { id: 'payment', label: '결제' },
  { id: 'settings', label: '설정' },
];

export default function App({ services, runtime }: { services: Services; runtime: PaymentRuntime }) {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('payment');

  // 탭이 열리면 어느 화면을 보고 있든 결제 연동을 시작하고, 페이지가 닫히거나 숨겨질 때 멈춘다.
  // 서버 주소나 매장 토큰이 비어 있으면 runtime.start() 는 아무것도 하지 않는다.
  useEffect(() => {
    void runtime.start();
    const onHide = () => void runtime.stop();
    const onShow = (e: PageTransitionEvent) => {
      if (e.persisted) void runtime.start();
    };
    window.addEventListener('pagehide', onHide);
    window.addEventListener('pageshow', onShow);
    return () => {
      window.removeEventListener('pagehide', onHide);
      window.removeEventListener('pageshow', onShow);
      void runtime.stop();
    };
  }, [runtime]);

  useEffect(() => {
    let alive = true;
    loadSettings(services.storage, services.secureStore).then(
      (s) => {
        if (alive) setSettings(s);
      },
      () => {
        if (!alive) return;
        setLoadError('저장된 설정을 읽지 못했어요. 설정을 다시 입력해 주세요');
        setSettings(DEFAULT_SETTINGS);
        setTab('settings');
      },
    );
    return () => {
      alive = false;
    };
  }, [services]);

  if (!settings) {
    return (
      <div className="app">
        <p className="muted center">불러오고 있어요</p>
      </div>
    );
  }

  return (
    <div className="app">
      <nav className="tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={tab === t.id ? 'on' : ''}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>
      <main>
        {loadError && <p className="notice error">{loadError}</p>}
        {tab === 'payment' && <Payment runtime={runtime} toast={services.toast} configured={isConfigured(settings)} />}
        {tab === 'settings' && <Settings services={services} runtime={runtime} settings={settings} onSaved={setSettings} />}
      </main>
    </div>
  );
}
