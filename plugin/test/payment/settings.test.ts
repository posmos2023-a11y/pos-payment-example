import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  SETTING_INPUTS,
  connectionChanged,
  normalizeServerUrl,
  normalizeSettings,
  toWsUrl,
} from '../../src/payment/settings.ts';

describe('SETTING_INPUTS (6.2 표와 정확히 일치)', () => {
  it('id / type / label / required / default', () => {
    const rows = SETTING_INPUTS.map((i) => [i.id, i.type, i.label, i.required, i.default]);
    assert.deepEqual(rows, [
      ['allowStartPayment', 'toggle', '전산 요청 시 결제 화면 자동 열기', false, true],
      ['matchCatalog', 'toggle', 'POS 등록 상품과 상품코드로 매칭', false, true],
      ['defaultItemCode', 'text', '기본 상품 코드(선택)', false, ''],
      ['showToast', 'toggle', '알림 표시', false, true],
    ]);
  });

  it('연결 대상(서버 주소·토큰·연결 방식)은 입력으로 두지 않는다', () => {
    const ids = SETTING_INPUTS.map((i) => i.id);
    for (const id of ['serverUrl', 'token', 'transport']) assert.equal(ids.includes(id), false);
  });
});

describe('normalizeSettings', () => {
  it('undefined / 빈 값은 기본값', () => {
    for (const input of [undefined, null, {}]) {
      assert.deepEqual(normalizeSettings(input), {
        serverUrl: '',
        wsUrl: '',
        token: '',
        transport: 'auto',
        allowStartPayment: true,
        matchCatalog: true,
        defaultItemCode: '',
        showToast: true,
      });
    }
  });

  it('serverUrl: 스킴이 없으면 https:// 를 붙이고, 이 PC·내부망 주소에만 http:// 를 붙인다', () => {
    // 매장 토큰이 요청마다 실리므로 평문(http)을 기본으로 하지 않는다
    assert.equal(normalizeServerUrl('erp.example.com'), 'https://erp.example.com');
    assert.equal(normalizeServerUrl('erp.example.com:8443/'), 'https://erp.example.com:8443');
    assert.equal(normalizeServerUrl('8.8.8.8:8787'), 'https://8.8.8.8:8787');
    assert.equal(normalizeServerUrl('172.32.0.1'), 'https://172.32.0.1');
    for (const local of ['localhost:8787', '127.0.0.1:8787', '10.0.0.5', '172.16.0.1:80', '192.168.0.10:8765', '[::1]:8787']) {
      assert.equal(normalizeServerUrl(local), `http://${local}`);
    }
    // 스킴을 직접 적으면 그대로 둔다
    assert.equal(normalizeServerUrl('http://erp.example.com'), 'http://erp.example.com');
  });

  it('serverUrl: trim, 끝 / 제거', () => {
    assert.equal(normalizeServerUrl('  192.168.0.10:8765/  '), 'http://192.168.0.10:8765');
    assert.equal(normalizeServerUrl('http://192.168.0.10:8765///'), 'http://192.168.0.10:8765');
    assert.equal(normalizeServerUrl('HTTPS://pos.example.com/'), 'HTTPS://pos.example.com');
    assert.equal(normalizeServerUrl(''), '');
    assert.equal(normalizeServerUrl('   '), '');
    assert.equal(normalizeServerUrl(undefined), '');
    assert.equal(normalizeServerUrl(123), '');
  });

  it('WebSocket 주소를 붙여 넣어도 http(s) 로 바꾼다', () => {
    assert.equal(normalizeServerUrl('ws://10.0.0.5:8765'), 'http://10.0.0.5:8765');
    assert.equal(normalizeServerUrl('wss://pos.example.com'), 'https://pos.example.com');
  });

  it('wsUrl: http -> ws, https -> wss, + /pos/ws', () => {
    assert.equal(normalizeSettings({ serverUrl: '192.168.0.10:8765' }).wsUrl, 'ws://192.168.0.10:8765/pos/ws');
    assert.equal(normalizeSettings({ serverUrl: 'https://pos.example.com/' }).wsUrl, 'wss://pos.example.com/pos/ws');
    assert.equal(toWsUrl(''), '');
  });

  it('transport: 허용된 값만, 아니면 auto', () => {
    assert.equal(normalizeSettings({ transport: 'ws' }).transport, 'ws');
    assert.equal(normalizeSettings({ transport: 'http' }).transport, 'http');
    assert.equal(normalizeSettings({ transport: 'carrier-pigeon' }).transport, 'auto');
    assert.equal(normalizeSettings({ transport: 5 }).transport, 'auto');
  });

  it('토글: boolean 만 인정, undefined/잘못된 값은 기본값 true', () => {
    const off = normalizeSettings({ allowStartPayment: false, matchCatalog: false, showToast: false });
    assert.equal(off.allowStartPayment, false);
    assert.equal(off.matchCatalog, false);
    assert.equal(off.showToast, false);
    const bad = normalizeSettings({ allowStartPayment: 'no', matchCatalog: 0, showToast: undefined });
    assert.equal(bad.allowStartPayment, true);
    assert.equal(bad.matchCatalog, true);
    assert.equal(bad.showToast, true);
  });

  it('token 은 trim, 문자열이 아니면 빈 문자열', () => {
    assert.equal(normalizeSettings({ token: '  abc  ' }).token, 'abc');
    assert.equal(normalizeSettings({ token: 42 }).token, '');
  });

  it('connectionChanged: 서버/토큰/전송 방식만 연결을 다시 만든다', () => {
    const a = normalizeSettings({ serverUrl: 'http://a:1', token: 't', transport: 'ws' });
    assert.equal(connectionChanged(a, { ...a, showToast: false, matchCatalog: false }), false);
    assert.equal(connectionChanged(a, { ...a, serverUrl: 'http://b:1' }), true);
    assert.equal(connectionChanged(a, { ...a, token: 'u' }), true);
    assert.equal(connectionChanged(a, { ...a, transport: 'http' }), true);
  });
});
