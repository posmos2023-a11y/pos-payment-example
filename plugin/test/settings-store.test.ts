import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_SETTINGS,
  KEY_ALLOW_START,
  KEY_DEFAULT_ITEM,
  KEY_MATCH_CATALOG,
  KEY_SERVER_URL,
  KEY_SHOW_TOAST,
  SECURE_KEY_TOKEN,
  buildBridgeValues,
  isConfigured,
  loadBridgeValues,
  loadSettings,
  normalizeUrlInput,
  saveSettings,
  validateServerUrl,
} from '../src/lib/settings-store.ts';
import { ACTIVITY_MAX, addActivity, parseActivity } from '../src/payment/activity.ts';
import { connectionChanged, normalizeSettings } from '../src/payment/settings.ts';
import type { StorageLike } from '../src/sdk-types.ts';

function memStore(): StorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    get: async (k) => map.get(k),
    set: async (k, v) => {
      map.set(k, v);
    },
    del: async (k) => {
      map.delete(k);
    },
  };
}

describe('설정 저장소', () => {
  it('비어 있으면 기본값(주소·토큰 빈 값, 결제 화면 자동 열기·매칭·알림 켜짐)', async () => {
    assert.deepEqual(await loadSettings(memStore(), memStore()), DEFAULT_SETTINGS);
    assert.equal(DEFAULT_SETTINGS.serverUrl, '');
    assert.equal(DEFAULT_SETTINGS.token, '');
  });

  it('저장한 값을 그대로 읽고, 토큰은 secureStore 에만 저장한다', async () => {
    const storage = memStore();
    const secure = memStore();
    const s = {
      serverUrl: 'https://erp.example.com',
      token: 'tok-1',
      allowStartPayment: false,
      matchCatalog: false,
      defaultItemCode: 'SVC',
      showToast: false,
    };
    await saveSettings(storage, secure, s);
    assert.deepEqual(await loadSettings(storage, secure), s);
    assert.deepEqual([...storage.map.keys()].sort(), [KEY_ALLOW_START, KEY_DEFAULT_ITEM, KEY_MATCH_CATALOG, KEY_SERVER_URL, KEY_SHOW_TOAST].sort());
    assert.deepEqual([...secure.map.keys()], [SECURE_KEY_TOKEN]);
    assert.equal([...storage.map.values()].includes('tok-1'), false);
  });

  it('토큰을 비워 저장하면 secureStore 에서 지운다', async () => {
    const storage = memStore();
    const secure = memStore();
    await saveSettings(storage, secure, { ...DEFAULT_SETTINGS, serverUrl: 'https://a.example.com', token: 'tok' });
    await saveSettings(storage, secure, { ...DEFAULT_SETTINGS, serverUrl: 'https://a.example.com', token: '' });
    assert.equal(secure.map.size, 0);
  });
});

describe('서버 주소 입력', () => {
  it('http 와 https 를 모두 허용하고, 스킴이 없으면 http:// 를 붙이고, 끝의 / 를 지운다', () => {
    assert.equal(normalizeUrlInput('https://erp.example.com/'), 'https://erp.example.com');
    assert.equal(normalizeUrlInput('  http://192.168.0.10:8080// '), 'http://192.168.0.10:8080');
    assert.equal(normalizeUrlInput('localhost:8080'), 'http://localhost:8080');
    assert.equal(normalizeUrlInput('wss://erp.example.com'), 'https://erp.example.com');
    assert.equal(normalizeUrlInput('ws://localhost:8080'), 'http://localhost:8080');
    assert.equal(normalizeUrlInput(''), '');
    assert.equal(normalizeUrlInput(undefined), '');
  });

  it('검증: 빈 값과 http/https 는 통과, 다른 스킴·공백은 거절', () => {
    assert.equal(validateServerUrl(''), null);
    assert.equal(validateServerUrl('http://localhost:8080'), null);
    assert.equal(validateServerUrl('https://erp.example.com'), null);
    assert.notEqual(validateServerUrl('ftp://erp.example.com'), null);
    assert.notEqual(validateServerUrl('http://erp example.com'), null);
    assert.notEqual(validateServerUrl('http://'), null);
  });
});

describe('브리지 연결값', () => {
  const ready = { ...DEFAULT_SETTINGS, serverUrl: 'http://localhost:8080', token: 'k-1', defaultItemCode: 'SVC' };

  it('주소 -> serverUrl, 토큰 -> token, 전송 방식은 auto, ws://…/pos/ws', () => {
    const values = buildBridgeValues(ready);
    assert.deepEqual(Object.keys(values).sort(), [
      'allowStartPayment',
      'defaultItemCode',
      'matchCatalog',
      'serverUrl',
      'showToast',
      'token',
      'transport',
    ]);
    const n = normalizeSettings(values);
    assert.equal(n.serverUrl, 'http://localhost:8080');
    assert.equal(n.wsUrl, 'ws://localhost:8080/pos/ws');
    assert.equal(n.token, 'k-1');
    assert.equal(n.transport, 'auto');
    assert.equal(n.defaultItemCode, 'SVC');
  });

  it('https 주소는 wss://…/pos/ws', () => {
    const n = normalizeSettings(buildBridgeValues({ ...ready, serverUrl: 'https://erp.example.com' }));
    assert.equal(n.wsUrl, 'wss://erp.example.com/pos/ws');
  });

  it('토큰이 비면 serverUrl 도 비어 브리지를 시작하지 않는다', () => {
    const s = { ...ready, token: '' };
    assert.equal(isConfigured(s), false);
    const n = normalizeSettings(buildBridgeValues(s));
    assert.equal(n.serverUrl, '');
    assert.equal(n.wsUrl, '');
    assert.equal(n.token, '');
  });

  it('주소가 비면 토큰이 있어도 브리지를 시작하지 않는다', () => {
    const s = { ...ready, serverUrl: '' };
    assert.equal(isConfigured(s), false);
    const n = normalizeSettings(buildBridgeValues(s));
    assert.equal(n.serverUrl, '');
    assert.equal(n.token, '');
  });

  it('아무것도 저장하지 않은 새 기기는 시작하지 않는다', async () => {
    const n = normalizeSettings(await loadBridgeValues(memStore(), memStore()));
    assert.equal(n.serverUrl, '');
    assert.equal(n.token, '');
  });

  it('저장소에서: 주소·토큰이 바뀌면 연결을 다시 만들고, 결제 옵션만 바뀌면 다시 만들지 않는다', async () => {
    const storage = memStore();
    const secure = memStore();
    await saveSettings(storage, secure, ready);
    const a = normalizeSettings(await loadBridgeValues(storage, secure));
    assert.equal(a.wsUrl, 'ws://localhost:8080/pos/ws');
    await saveSettings(storage, secure, { ...ready, token: 'k-2' });
    const b = normalizeSettings(await loadBridgeValues(storage, secure));
    assert.equal(connectionChanged(a, b), true);
    await saveSettings(storage, secure, { ...ready, token: 'k-2', showToast: false });
    const c = normalizeSettings(await loadBridgeValues(storage, secure));
    assert.equal(c.showToast, false);
    assert.equal(connectionChanged(b, c), false);
    await saveSettings(storage, secure, { ...ready, token: 'k-2', serverUrl: 'https://other.example.com' });
    assert.equal(connectionChanged(c, normalizeSettings(await loadBridgeValues(storage, secure))), true);
  });
});

describe('처리 내역', () => {
  it('최근 20개만 남기고, 잘못된 저장값은 무시한다', () => {
    let list: ReturnType<typeof parseActivity> = [];
    for (let i = 0; i < 25; i++) list = addActivity(list, { at: new Date(i * 1000).toISOString(), label: `L${i}`, result: 'added' });
    assert.equal(list.length, ACTIVITY_MAX);
    assert.equal(list[0]!.label, 'L5');
    assert.deepEqual(parseActivity(JSON.stringify(list)), list);
    assert.deepEqual(parseActivity('깨짐'), []);
    assert.deepEqual(parseActivity(JSON.stringify([{ at: 'x', label: 'a', result: '이상한값' }])), []);
  });
});
