// 매장·토큰 파일(data/shops.json). 예제이므로 토큰을 평문으로 저장한다.
// 실제 서비스에서는 DB 에 해시로 저장하고, 매장 직원에게 토큰을 한 번만 보여 주세요.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function newToken() {
  return randomBytes(18).toString('base64url'); // 144비트 난수
}

function shopsFile(dataDir) {
  return join(dataDir, 'shops.json');
}

export function saveShops(dataDir, shops) {
  mkdirSync(dataDir, { recursive: true });
  const file = shopsFile(dataDir);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify({ shops }, null, 2), 'utf8');
  renameSync(tmp, file);
}

/** 파일이 없으면 시험 매장 1개를 만들고 token 을 한 번 알려 준다(onCreated). */
export function loadOrCreateShops(dataDir, onCreated = () => {}) {
  const file = shopsFile(dataDir);
  if (!existsSync(file)) {
    const shop = { id: 1, name: '시험 매장', token: newToken() };
    saveShops(dataDir, [shop]);
    onCreated(shop);
    return [shop];
  }
  const data = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(data.shops)) throw new Error(`${file}: shops 배열이 없어요`);
  return data.shops;
}

export function addShop(dataDir, name) {
  const shops = loadOrCreateShops(dataDir);
  const shop = { id: Math.max(0, ...shops.map((s) => s.id)) + 1, name, token: newToken() };
  shops.push(shop);
  saveShops(dataDir, shops);
  return shop;
}
