// 실제 토스 POS SDK 를 얇은 인터페이스(sdk-types.ts, payment/sdk-types.ts)에 연결한다.
// 이 파일만 SDK 를 런타임에 import 한다(테스트는 이 파일을 쓰지 않는다).
import { posPluginSdk } from '@tossplace/pos-plugin-sdk';
import { loadBridgeValues } from './lib/settings-store.ts';
import { systemClock } from './payment/clock.ts';
import type { PaymentRuntime } from './payment/runtime.ts';
import { createPaymentRuntime } from './payment/runtime.ts';
import type { SdkLike, SettingValue } from './payment/sdk-types.ts';
import type { SecureStoreLike, Services, StorageLike } from './sdk-types.ts';

// vite.config.ts 의 define 으로 package.json 의 version 이 들어온다.
declare const __APP_VERSION__: string;
const APP_VERSION: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev';

// 타입 검사: 실제 SDK 가 인터페이스에 대입 가능해야 한다.
const storage: StorageLike = posPluginSdk.storage;
const secureStore: SecureStoreLike = posPluginSdk.secureStore;

export const realServices: Services = {
  storage,
  secureStore,
  toast: {
    success: (message) => posPluginSdk.toast.success({ message }),
    error: (message) => posPluginSdk.toast.error({ message }),
    warn: (message) => posPluginSdk.toast.warn({ message }),
  },
};

// 결제 연동(bridge)이 쓰는 SDK. 실제 SDK 가 SdkLike 의 각 항목에 대입 가능한지 tsc 가 검증한다.
// 설정은 POS 설정 화면(setting.setInputs)이 아니라 탭 [설정] 화면이 저장하므로 getValues 만 탭 저장소에서 읽어 준다.
const bridgeSdk: SdkLike = {
  draftOrder: posPluginSdk.draftOrder,
  websocket: posPluginSdk.websocket,
  http: posPluginSdk.http,
  storage: posPluginSdk.storage,
  toast: posPluginSdk.toast,
  setting: {
    setInputs: async () => {},
    getValues: async <T extends Record<string, SettingValue>>() =>
      (await loadBridgeValues(storage, secureStore)) as T,
    on: () => {},
  },
  catalog: posPluginSdk.catalog,
  category: posPluginSdk.category,
  order: posPluginSdk.order,
  payment: posPluginSdk.payment,
  merchant: posPluginSdk.merchant,
  plugin: posPluginSdk.plugin,
  error: posPluginSdk.error,
};

export const paymentRuntime: PaymentRuntime = createPaymentRuntime({
  sdk: bridgeSdk,
  clock: systemClock,
  pluginVersion: APP_VERSION,
  log: (level, message) => {
    const line = `[payment-example] ${message}`;
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  },
});
