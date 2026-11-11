// 사용법: npm run add-shop -- "매장 이름"
// 새 매장과 토큰을 data/shops.json 에 추가한다. 실행 중인 서버는 다시 시작해야 새 매장을 알아본다.
import { fileURLToPath } from 'node:url';
import { addShop } from '../src/shops.js';

const name = process.argv.slice(2).join(' ').trim();
if (!name) {
  console.error('사용법: npm run add-shop -- "매장 이름"');
  process.exit(1);
}
const dataDir = fileURLToPath(new URL('../data', import.meta.url));
const shop = addShop(dataDir, name);
console.log(`매장 추가: #${shop.id} ${shop.name}`);
console.log(`연동 토큰: ${shop.token}`);
console.log('이 토큰을 매장 POS 의 플러그인 설정(연동 토큰)에 입력하세요. 서버를 다시 시작해야 반영돼요.');
