// 탭 앱 안의 결제 연동 수명.
//  - 이벤트(draft/payment/catalog/error)는 만들 때 한 번만 등록한다(SDK 에 해제 API 가 없고, StrictMode 에서 두 번 마운트돼도 중복되지 않게).
//  - start()/stop() 은 여러 번 불러도 안전하다(순서대로 처리). 탭이 열리면 start, pagehide/언마운트 때 stop.
//  - 설정(setting.setInputs)은 쓰지 않는다. 설정은 탭 [설정] 화면이 저장하고 applySettings() 로 알린다.
import type { Bridge, TransportFactory } from './bridge.ts';
import { createBridge } from './bridge.ts';
import type { Clock } from './clock.ts';
import type { LogLevel } from './protocol.ts';
import type { SdkLike, SettingValue } from './sdk-types.ts';
import { normalizeSettings } from './settings.ts';
import { createTransport } from './transport.ts';

export interface PaymentRuntimeOptions {
  sdk: SdkLike;
  clock: Clock;
  log: (level: LogLevel, message: string) => void;
  pluginVersion: string;
  /** 테스트용. 기본은 실제 전송 계층 */
  transportFactory?: TransportFactory;
}

export interface PaymentRuntime {
  readonly bridge: Bridge;
  /** 서버 주소와 매장 토큰이 있으면 bridge 를 시작한다. */
  start(): Promise<void>;
  stop(): Promise<void>;
  /** [설정] 저장 뒤: 시작/중지/설정 다시 읽기를 알아서 고른다. */
  applySettings(): Promise<void>;
  isRunning(): boolean;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function createPaymentRuntime(opts: PaymentRuntimeOptions): PaymentRuntime {
  const { sdk, clock, log } = opts;
  const pluginInfo = { name: 'payment-example-plugin', fetched: false };

  const bridge = createBridge({
    sdk,
    clock,
    log,
    pluginVersion: opts.pluginVersion,
    pluginName: () => pluginInfo.name,
    transportFactory:
      opts.transportFactory ??
      ((ctx) =>
        createTransport(ctx.settings.transport, {
          sdk,
          clock,
          wsUrl: ctx.settings.wsUrl,
          httpBase: ctx.settings.serverUrl,
          token: ctx.settings.token,
          clientId: ctx.clientId,
          getHello: ctx.getHello,
          log: ctx.log,
          notify: ctx.notify,
        })),
  });

  // 이벤트 등록은 동기적으로, 한 번만(초기화 중에 발생한 이벤트를 놓치지 않도록).
  sdk.error.addErrorListener((error) => log('error', `오류: ${errText(error)}`));
  sdk.draftOrder.on('update', (draft) => {
    try {
      bridge.onDraftUpdate(draft);
    } catch (e) {
      log('error', `draft 이벤트 처리 실패: ${errText(e)}`);
    }
  });
  sdk.payment.on('paid', (paymentId, orderId) => {
    bridge.onPaid(paymentId, orderId).catch((e) => log('error', `결제 이벤트 처리 실패: ${errText(e)}`));
  });
  sdk.payment.on('cancel', (paymentId, orderId) => {
    try {
      bridge.onCancel(paymentId, orderId);
    } catch (e) {
      log('error', `결제 취소 이벤트 처리 실패: ${errText(e)}`);
    }
  });
  for (const event of ['add', 'update', 'delete'] as const) {
    sdk.catalog.on(event, () => bridge.markCatalogStale());
  }

  let running = false;
  let chain: Promise<void> = Promise.resolve();
  const enqueue = (fn: () => Promise<void>): Promise<void> => {
    chain = chain.then(fn).catch((e) => log('error', `결제 연동 처리 실패: ${errText(e)}`));
    return chain;
  };

  async function hasConnection(): Promise<boolean> {
    try {
      const values = await sdk.setting.getValues<Record<string, SettingValue>>();
      return normalizeSettings(values).serverUrl !== '';
    } catch (e) {
      log('warn', `설정을 읽지 못했어요: ${errText(e)}`);
      return false;
    }
  }

  async function doStart(): Promise<void> {
    if (running) return;
    if (!(await hasConnection())) return; // 매장 토큰이 없으면 시작하지 않는다
    // 초기 임시 주문 캐시 (실패해도 계속)
    try {
      bridge.onDraftUpdate(await sdk.draftOrder.get());
    } catch (e) {
      log('warn', `초기 임시 주문을 읽지 못했어요: ${errText(e)}`);
    }
    // 플러그인 정보는 1회만 조회한다(호출 제한 메서드). 실패해도 무시.
    if (!pluginInfo.fetched) {
      pluginInfo.fetched = true;
      try {
        const info = await sdk.plugin.getPluginInfo();
        if (info && typeof info.name === 'string' && info.name !== '') pluginInfo.name = info.name;
      } catch {
        // 무시
      }
    }
    await bridge.start();
    running = true;
    log('info', `결제 연동 시작 (v${opts.pluginVersion})`);
  }

  async function doStop(): Promise<void> {
    if (!running) return;
    running = false;
    await bridge.stop();
  }

  return {
    bridge,
    start: () => enqueue(doStart),
    stop: () => enqueue(doStop),
    applySettings: () =>
      enqueue(async () => {
        const has = await hasConnection();
        if (!has) {
          await doStop();
        } else if (!running) {
          await doStart();
        } else {
          await bridge.reloadSettings();
        }
      }),
    isRunning: () => running,
  };
}
