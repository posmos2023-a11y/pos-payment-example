// 설정 저장/불러오기.
//  - 정비 전산 서버 주소: storage(gm.serverUrl)
//  - 매장 토큰: secureStore(gm.token)
//  - 결제 옵션 4개: storage
// bridge 는 "설정 값 맵"을 읽는다: buildBridgeValues() 가 그 맵을 만든다(src/sdk.ts 의 setting.getValues).
// 서버 주소나 토큰이 비어 있으면 serverUrl 을 비워서 bridge 를 시작하지 않게 한다.
import type { SettingValue } from '../payment/sdk-types.ts';
import { normalizeServerUrl } from '../payment/settings.ts';
import type { SecureStoreLike, StorageLike } from '../sdk-types.ts';

export const KEY_SERVER_URL = 'gm.serverUrl';
export const SECURE_KEY_TOKEN = 'gm.token';
export const KEY_ALLOW_START = 'gm.allowStartPayment';
export const KEY_MATCH_CATALOG = 'gm.matchCatalog';
export const KEY_DEFAULT_ITEM = 'gm.defaultItemCode';
export const KEY_SHOW_TOAST = 'gm.showToast';

export interface AppSettings {
  /** 정규화된 서버 주소(http:// 또는 https://, 끝 '/' 없음). 기본값은 빈 문자열 */
  serverUrl: string;
  /** 매장 토큰 */
  token: string;
  allowStartPayment: boolean;
  matchCatalog: boolean;
  defaultItemCode: string;
  showToast: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  serverUrl: '',
  token: '',
  allowStartPayment: true,
  matchCatalog: true,
  defaultItemCode: '',
  showToast: true,
};

/** 입력한 주소를 정리한다(앞뒤 공백·끝 '/' 제거, 스킴이 없으면 https://(이 PC·내부망 주소만 http://), ws(s):// 는 http(s):// 로). 비어 있으면 ''. */
export function normalizeUrlInput(raw: unknown): string {
  return normalizeServerUrl(raw);
}

/** 정규화된 주소가 쓸 수 있는지. 비어 있으면 허용(연동 중지). 문제가 있으면 안내 문구, 없으면 null. */
export function validateServerUrl(url: string): string | null {
  if (url === '') return null;
  if (!/^https?:\/\//i.test(url)) return 'http:// 또는 https:// 로 시작하는 주소만 쓸 수 있어요';
  if (/\s/.test(url)) return '주소에 공백이 들어 있어요';
  try {
    if (new URL(url).hostname === '') return '주소를 다시 확인해 주세요';
  } catch {
    return '주소를 다시 확인해 주세요';
  }
  return null;
}

/** 서버 주소와 매장 토큰이 모두 있어야 결제 연동을 시작한다. */
export function isConfigured(s: Pick<AppSettings, 'serverUrl' | 'token'>): boolean {
  return s.serverUrl !== '' && s.token !== '';
}

function readBool(v: string | undefined, fallback: boolean): boolean {
  return v === 'true' ? true : v === 'false' ? false : fallback;
}

export async function loadSettings(storage: StorageLike, secure: SecureStoreLike): Promise<AppSettings> {
  const [url, token, allow, match, defCode, toast] = await Promise.all([
    storage.get(KEY_SERVER_URL),
    secure.get(SECURE_KEY_TOKEN),
    storage.get(KEY_ALLOW_START),
    storage.get(KEY_MATCH_CATALOG),
    storage.get(KEY_DEFAULT_ITEM),
    storage.get(KEY_SHOW_TOAST),
  ]);
  return {
    serverUrl: normalizeUrlInput(url),
    token: (token ?? '').trim(),
    allowStartPayment: readBool(allow, true),
    matchCatalog: readBool(match, true),
    defaultItemCode: (defCode ?? '').trim(),
    showToast: readBool(toast, true),
  };
}

export async function saveSettings(storage: StorageLike, secure: SecureStoreLike, s: AppSettings): Promise<void> {
  await storage.set(KEY_SERVER_URL, s.serverUrl);
  if (s.token === '') await secure.del(SECURE_KEY_TOKEN);
  else await secure.set(SECURE_KEY_TOKEN, s.token);
  await storage.set(KEY_ALLOW_START, String(s.allowStartPayment));
  await storage.set(KEY_MATCH_CATALOG, String(s.matchCatalog));
  await storage.set(KEY_DEFAULT_ITEM, s.defaultItemCode);
  await storage.set(KEY_SHOW_TOAST, String(s.showToast));
}

/** bridge 의 normalizeSettings 가 읽는 값 맵. 주소나 토큰이 비어 있으면 serverUrl 과 token 을 모두 비운다. */
export function buildBridgeValues(s: AppSettings): Record<string, SettingValue> {
  const ready = isConfigured(s);
  return {
    serverUrl: ready ? s.serverUrl : '',
    token: ready ? s.token : '',
    transport: 'auto',
    allowStartPayment: s.allowStartPayment,
    matchCatalog: s.matchCatalog,
    defaultItemCode: s.defaultItemCode,
    showToast: s.showToast,
  };
}

export async function loadBridgeValues(storage: StorageLike, secure: SecureStoreLike): Promise<Record<string, SettingValue>> {
  return buildBridgeValues(await loadSettings(storage, secure));
}
