// 환경변수 설정. 값이 비어 있으면 기본값을 쓴다.
const DEFAULT_BASE_URL = 'https://open-api.tossplace.com/api-public/openapi/v1';

export function loadConfig(env = process.env) {
  const text = (name) => (env[name] ?? '').trim();
  const port = Number(text('PORT')) || 8787;
  const adminPassword = text('ADMIN_PASSWORD');
  if (adminPassword && adminPassword.length < 12) throw new Error('ADMIN_PASSWORD 는 12자 이상이어야 해요');
  const shopToken = text('SHOP_TOKEN');
  if (shopToken && shopToken.length < 24) throw new Error('SHOP_TOKEN 은 24자 이상이어야 해요');
  return {
    // 기본은 이 PC 안에서만 접속. 0.0.0.0 으로 열면 외부에 노출되니 주의하세요.
    host: text('HOST') || '127.0.0.1',
    port, // POS 창구(/pos/*)와 토스 웹훅. 프록시·터널은 이 포트만 넘긴다
    adminPort: Number(text('ADMIN_PORT')) || port + 1, // 정비 전산 흉내 화면(인증 없음). 항상 127.0.0.1 에만 연다
    // 값이 있으면 화면·/api/* 를 POS 포트에도 열되 HTTP Basic 인증을 건다(클라우드 시험용). 없으면 ADMIN_PORT 로만.
    adminPassword,
    // 값이 있고 data/shops.json 이 없을 때, 이 토큰으로 시험 매장을 만든다(재시작하면 파일이 사라지는 클라우드용)
    shopToken,
    shopName: text('SHOP_NAME'),
    tossWebhookSecret: text('TOSS_WEBHOOK_SECRET'),
    tossAccessKey: text('TOSS_OPENAPI_ACCESS_KEY'),
    tossSecretKey: text('TOSS_OPENAPI_SECRET_KEY'),
    tossBaseUrl: text('TOSS_OPENAPI_BASE_URL') || DEFAULT_BASE_URL,
  };
}
