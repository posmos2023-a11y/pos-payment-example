// 설정 화면 정의(setting.setInputs)와 값 정규화.
import type { SettingInput } from './sdk-types.ts';

export type TransportMode = 'auto' | 'ws' | 'http';

export interface PluginSettings {
  /** 정규화된 서버 주소(http:// 또는 https://, 끝 '/' 없음). 비어 있으면 '' */
  serverUrl: string;
  /** serverUrl 기반 WebSocket 주소(`.../pos/ws`). serverUrl 이 비면 '' */
  wsUrl: string;
  token: string;
  transport: TransportMode;
  allowStartPayment: boolean;
  matchCatalog: boolean;
  /** 상품코드로 못 찾을 때 밑판으로 쓸 POS 상품 코드(선택) */
  defaultItemCode: string;
  showToast: boolean;
}

export const SETTING_INPUTS: SettingInput[] = [
  {
    id: 'allowStartPayment',
    type: 'toggle',
    label: '전산 요청 시 결제 화면 자동 열기',
    required: false,
    default: true,
  },
  {
    id: 'matchCatalog',
    type: 'toggle',
    label: 'POS 등록 상품과 상품코드로 매칭',
    required: false,
    default: true,
  },
  {
    id: 'defaultItemCode',
    type: 'text',
    label: '기본 상품 코드(선택)',
    required: false,
    default: '',
  },
  {
    id: 'showToast',
    type: 'toggle',
    label: '알림 표시',
    required: false,
    default: true,
  },
];

export const EMPTY_URL_WARNING = '[설정] 탭에서 서버 주소와 매장 토큰을 넣어 주세요';

/**
 * 이 PC·내부망 주소인지(스킴 없는 "호스트[:포트][/경로]" 를 받는다).
 * localhost, 127.x.x.x, [::1], 사설 IPv4(10.x, 172.16~31.x, 192.168.x)만 해당한다.
 */
export function isLocalAddress(hostAndRest: string): boolean {
  const host = hostAndRest.split('/')[0]!.replace(/:\d+$/, '').toLowerCase();
  if (host === 'localhost' || host === '[::1]') return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

/**
 * 사용자가 입력한 주소를 정리한다.
 * - 앞뒤 공백 제거, 끝의 '/' 제거
 * - 스킴이 없으면 https:// 를 붙인다. 매장 토큰이 요청마다 실리므로 평문(http)을 기본으로 하지 않는다.
 *   이 PC·내부망 주소(로컬 시험)일 때만 http:// 를 붙인다. 그 밖의 주소에 http 를 쓰려면 http:// 를 직접 적어야 한다.
 * - ws:// -> http://, wss:// -> https:// (WebSocket 주소를 그대로 붙여 넣은 경우 허용)
 */
export function normalizeServerUrl(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  let url = raw.trim();
  if (url === '') return '';
  if (/^wss:\/\//i.test(url)) url = 'https://' + url.slice(6);
  else if (/^ws:\/\//i.test(url)) url = 'http://' + url.slice(5);
  else if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = (isLocalAddress(url) ? 'http://' : 'https://') + url;
  url = url.replace(/\/+$/, '');
  return url;
}

/** http(s)://host:port -> ws(s)://host:port/pos/ws */
export function toWsUrl(httpBase: string): string {
  if (httpBase === '') return '';
  const base = /^https:\/\//i.test(httpBase)
    ? 'wss://' + httpBase.slice(8)
    : /^http:\/\//i.test(httpBase)
      ? 'ws://' + httpBase.slice(7)
      : httpBase;
  return base + '/pos/ws';
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

export function normalizeSettings(values?: Record<string, unknown> | null): PluginSettings {
  const v = values ?? {};
  const serverUrl = normalizeServerUrl(v.serverUrl);
  const transport: TransportMode =
    v.transport === 'ws' || v.transport === 'http' || v.transport === 'auto' ? v.transport : 'auto';
  return {
    serverUrl,
    wsUrl: toWsUrl(serverUrl),
    token: typeof v.token === 'string' ? v.token.trim() : '',
    transport,
    allowStartPayment: bool(v.allowStartPayment, true),
    matchCatalog: bool(v.matchCatalog, true),
    defaultItemCode: typeof v.defaultItemCode === 'string' ? v.defaultItemCode.trim() : '',
    showToast: bool(v.showToast, true),
  };
}

/** 연결(전송 계층)을 다시 만들어야 하는 변경인지. */
export function connectionChanged(a: PluginSettings, b: PluginSettings): boolean {
  return a.serverUrl !== b.serverUrl || a.token !== b.token || a.transport !== b.transport;
}
