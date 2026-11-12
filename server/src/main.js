// 실행 진입점: npm start
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { loadOrCreateShops, saveShops } from './shops.js';
import { createApp } from './server.js';

let config;
let shops;
const dataDir = fileURLToPath(new URL('../data', import.meta.url));
try {
  config = loadConfig();
  shops = loadOrCreateShops(dataDir, (shop) => {
    if (config.shopToken) {
      console.log('SHOP_TOKEN 으로 시험 매장을 만들었어요'); // 환경변수로 받은 토큰은 콘솔에 다시 찍지 않는다
    } else {
      console.log(`시험 매장을 만들었어요: #${shop.id} ${shop.name}`);
      console.log(`연동 토큰(로컬 시험용, 이번 한 번만 출력해요. data/shops.json 에 저장됨): ${shop.token}`);
    }
  }, { token: config.shopToken, name: config.shopName });
} catch (err) {
  console.error(`시작할 수 없어요: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}

const app = createApp({
  shops,
  config,
  persistShops: (list) => saveShops(dataDir, list),
  logger: (level, text) => console.log(`[${new Date().toISOString()}] ${level} ${text}`),
});

// ADMIN_PASSWORD 가 있으면 화면을 POS 포트에 함께 열고(Basic 인증), 없으면 127.0.0.1 의 별도 포트에만 연다
const port = await app.listen(config.port, config.host, config.adminPassword ? {} : { adminPort: config.adminPort });
console.log(`POS 창구·웹훅: http://${config.host}:${port}  (매장 ${shops.length}곳)`);
if (config.adminPassword) {
  console.log('정비 전산 흉내 화면: POS 포트의 / 에서 열려요 (HTTP Basic 인증, 비밀번호는 ADMIN_PASSWORD). 시험용이에요');
} else {
  console.log(`정비 전산 흉내 화면: http://127.0.0.1:${app.adminPort}  (이 PC 에서만 열려요. 이 포트는 프록시·터널로 넘기지 마세요)`);
}
if (!config.tossWebhookSecret) console.log('TOSS_WEBHOOK_SECRET 이 없어서 /toss/webhook 은 503 으로 응답해요.');
if (!config.tossAccessKey || !config.tossSecretKey) {
  console.log('토스 Open API 키가 없어서 결제 승인 웹훅은 처리하지 않아요.');
  console.log('주의(시험 모드): 키가 없으면 POS 단말이 보낸 payment.paid 를 확인 없이 그대로 반영해요. 운영에서는 반드시 키를 넣으세요.');
}
if (!['127.0.0.1', 'localhost', '::1'].includes(config.host)) {
  console.log(`주의: HOST=${config.host} 로 열렸어요. POS 창구에 외부에서 접속할 수 있으니 방화벽·프록시를 확인하세요.`);
}

const stop = async () => {
  await app.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
