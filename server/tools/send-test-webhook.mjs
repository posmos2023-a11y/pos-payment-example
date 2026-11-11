// 시크릿으로 서명한 가짜 토스 결제 웹훅을 보낸다 (서명 검증 시험용).
//
// 사용법
//   node tools/send-test-webhook.mjs --secret <웹훅 시크릿> [옵션]
//   (시크릿은 환경변수 TOSS_WEBHOOK_SECRET 으로도 줄 수 있어요)
//
// 옵션
//   --url <주소>          기본 http://127.0.0.1:8787/toss/webhook
//   --type approved|cancelled   이벤트 종류 (기본 approved)
//   --merchant-id <id>    토스 가맹점 ID (기본 TEST-MERCHANT)
//   --payment-id <id>     결제 ID (기본 무작위)
//   --order-id <id>       주문 ID (기본 무작위)
//   --amount <원>         결제 금액 (기본 1000)
//   --webhook-id <id>     x-toss-webhook-id (기본 무작위. 같은 값을 두 번 보내면 중복 시험)
//   --timestamp <epoch ms>  x-toss-timestamp (기본 지금. 5분 넘게 어긋나면 서버가 400)
//   --tamper              서명 한 글자를 바꿔 보낸다 (서버가 401 로 거절해야 함)
import { randomBytes } from 'node:crypto';
import { signWebhook } from '../src/toss.js';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};

const secret = opt('secret', process.env.TOSS_WEBHOOK_SECRET ?? '');
if (!secret) {
  console.error('사용법: node tools/send-test-webhook.mjs --secret <웹훅 시크릿> [--type approved|cancelled] [--tamper]');
  process.exit(1);
}
const url = opt('url', 'http://127.0.0.1:8787/toss/webhook');
const type = opt('type', 'approved') === 'cancelled' ? 'payment.payment.cancelled.v1' : 'payment.payment.approved.v1';
const merchantId = opt('merchant-id', 'TEST-MERCHANT');
const paymentId = opt('payment-id', `testpay-${randomBytes(4).toString('hex')}`);
const orderId = opt('order-id', `testord-${randomBytes(4).toString('hex')}`);
const timestamp = String(opt('timestamp', Date.now()));

const body = JSON.stringify({
  id: `evt-${randomBytes(4).toString('hex')}`,
  type,
  createdAt: new Date().toISOString(),
  merchantId,
  app: 'test',
  data: { payment: { id: paymentId, orderId, amount: Number(opt('amount', 1000)), merchantId } },
});

let signature = signWebhook(secret, timestamp, Buffer.from(body, 'utf8'));
if (args.includes('--tamper')) signature = signature.slice(0, -1) + (signature.endsWith('0') ? '1' : '0');

const res = await fetch(url, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-toss-webhook-id': opt('webhook-id', `wh-${randomBytes(6).toString('hex')}`),
    'x-toss-timestamp': timestamp,
    'x-toss-signature': signature,
  },
  body,
});
console.log(`${type} paymentId=${paymentId} orderId=${orderId}`);
console.log(`응답: HTTP ${res.status} ${await res.text()}`);
