// 가짜 POS 플러그인: 실제 POS 없이 이 서버를 시험한다.
//
// 사용법
//   node tools/fake-pos.mjs --url http://127.0.0.1:8787 --token <매장 토큰> [옵션]
//
// 옵션
//   --url <주소>          서버 기준 주소 (기본 http://127.0.0.1:8787). https 는 wss 로 바뀐다
//   --token <토큰>        매장 토큰 (없으면 환경변수 POS_TOKEN)
//   --client-id <id>      단말 ID (기본: 무작위)
//   --merchant-id <id>    hello 에 넣을 토스 가맹점 ID (웹훅 시험에 필요)
//   --pay                 [담기] 명령(startPayment=true)을 받으면 잠시 뒤 payment.paid 를 보낸다
//   --paid-value <원>     --pay 일 때 결제액을 이 값으로 보낸다 (작업 합계와 다르면 "확인 필요" 시험)
//   --pay-delay <ms>      --pay 결제 지연 (기본 500)
//   --fail                명령에 ok=false 로 ack 한다 (실패 사유 표시 시험)
//   --no-ack              명령을 받아도 ack 하지 않는다 (30초 재전송 시험)
// 실행 중 입력: "cancel" + Enter -> 마지막 결제에 대해 payment.cancelled 를 보낸다
import { randomBytes } from 'node:crypto';
import readline from 'node:readline';
import WebSocket from 'ws';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const flag = (name) => args.includes(`--${name}`);

const base = new URL(opt('url', 'http://127.0.0.1:8787'));
const token = opt('token', process.env.POS_TOKEN ?? '');
if (!token) {
  console.error('사용법: node tools/fake-pos.mjs --url http://127.0.0.1:8787 --token <매장 토큰> [--pay]');
  process.exit(1);
}
const clientId = opt('client-id', `fake-${randomBytes(4).toString('hex')}`);
const merchantId = opt('merchant-id', '');
const payDelay = Number(opt('pay-delay', 500));
const paidOverride = opt('paid-value') === undefined ? null : Number(opt('paid-value'));

const wsUrl = new URL('/pos/ws', base);
wsUrl.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
wsUrl.searchParams.set('c', randomBytes(4).toString('hex')); // 플러그인도 붙이는 값. 서버는 무시한다

const processed = []; // 처리한 명령 id (hello 의 processedIds)
const cartLines = new Map(); // key -> 라인 (가짜 POS 장바구니)
let lastPayment = null;
let ws;
let welcomed = false;
let helloTimer;

const log = (...a) => console.log(new Date().toLocaleTimeString('ko-KR', { hour12: false }), ...a);
const send = (obj) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(obj));

function sendHello() {
  send({
    type: 'hello', clientId, pluginName: 'fake-pos', pluginVersion: '1.0.0', transport: 'ws',
    processedIds: processed.slice(-50), ...(merchantId ? { merchantId } : {}),
  });
}

function draftSummary() {
  const lines = [...cartLines.values()];
  const ids = new Set(lines.map((l) => Number(/^gm-(\d+)-/.exec(l.key)?.[1])));
  return {
    lineCount: lines.length,
    totalQuantity: lines.reduce((s, l) => s + l.quantity, 0),
    orderPriceValue: lines.reduce((s, l) => s + l.unitPrice * l.quantity, 0),
    ourKeys: lines.map((l) => l.key),
    workOrderIds: [...ids],
    lines: lines.map((l) => ({ key: l.key, title: l.title, quantity: l.quantity, priceValue: l.unitPrice })),
    updatedAt: new Date().toISOString(),
  };
}

function onCommand(cmd) {
  log(`명령 수신 ${cmd.id} ${cmd.kind}`, cmd.payload?.workOrderId ?? '');
  if (flag('no-ack')) return;
  if (flag('fail')) {
    send({ type: 'ack', commandId: cmd.id, ok: false, error: '가짜 POS: 시험용 실패', draft: draftSummary() });
    return;
  }
  const p = cmd.payload;
  if (cmd.kind === 'SYNC_CART') {
    if (p.exclusive) for (const k of [...cartLines.keys()]) if (!k.startsWith(`gm-${p.workOrderId}-`)) cartLines.delete(k);
    for (const k of [...cartLines.keys()]) if (k.startsWith(`gm-${p.workOrderId}-`)) cartLines.delete(k);
    for (const l of p.lines) cartLines.set(l.key, l);
  } else if (cmd.kind === 'CLEAR_CART') {
    cartLines.clear();
  }
  processed.push(cmd.id);
  send({ type: 'ack', commandId: cmd.id, ok: true, draft: draftSummary() });
  log(`ack ok, 가짜 POS 장바구니 ${cartLines.size}줄`);

  if (flag('pay') && cmd.kind === 'SYNC_CART' && p.startPayment && p.lines.length > 0) {
    setTimeout(() => pay(p.workOrderId, p.lines), payDelay);
  }
}

function pay(workOrderId, lines) {
  const total = lines.reduce((s, l) => s + l.unitPrice * l.quantity, 0);
  const paidValue = paidOverride ?? total;
  lastPayment = { paymentId: `fakepay-${randomBytes(4).toString('hex')}`, orderId: `fakeord-${randomBytes(4).toString('hex')}` };
  send({
    type: 'payment.paid', ...lastPayment, workOrderIds: [workOrderId],
    fullyPaid: true, paidValue, unpaidValue: 0,
  });
  log(`payment.paid 전송 ${lastPayment.paymentId} ${paidValue}원`);
}

function connect() {
  ws = new WebSocket(wsUrl, { headers: { Authorization: `Bearer ${token}` } });
  ws.on('unexpected-response', (_req, res) => {
    log(`접속 거절: HTTP ${res.statusCode}${res.statusCode === 401 ? ' (토큰이 맞지 않아요)' : ''}`);
    setTimeout(connect, 3000);
  });
  ws.on('open', () => {
    log('WebSocket 연결, hello 전송');
    welcomed = false;
    sendHello();
    helloTimer = setInterval(() => { if (!welcomed) sendHello(); }, 3000); // welcome 을 받을 때까지 3초마다
  });
  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg.type === 'welcome') { welcomed = true; log(`welcome 수신 (서버 ${msg.serverVersion})`); }
    else if (msg.type === 'ping') send({ type: 'pong', t: msg.t });
    else if (msg.type === 'command') onCommand(msg.command);
    else if (msg.type === 'error') log(`서버 오류 ${msg.code}`);
  });
  ws.on('close', () => {
    clearInterval(helloTimer);
    log('연결이 끊겼어요. 3초 뒤 다시 연결');
    setTimeout(connect, 3000);
  });
  ws.on('error', () => {}); // close 에서 처리
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (line.trim() === 'cancel' && lastPayment) {
    send({ type: 'payment.cancelled', paymentId: lastPayment.paymentId, orderId: lastPayment.orderId });
    log(`payment.cancelled 전송 ${lastPayment.paymentId}`);
  }
});

log(`가짜 POS 시작 clientId=${clientId} -> ${wsUrl.origin}`);
connect();
