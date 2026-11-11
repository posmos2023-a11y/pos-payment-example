// 환경변수 설정. 값이 비어 있으면 기본값을 쓴다.
const DEFAULT_BASE_URL = 'https://open-api.tossplace.com/api-public/openapi/v1';

export function loadConfig(env = process.env) {
  const text = (name) => (env[name] ?? '').trim();
  const port = Number(text('PORT')) || 8787;
  return {
    // 기본은 이 PC 안에서만 접속. 0.0.0.0 으로 열면 외부에 노출되니 주의하세요.
    host: text('HOST') || '127.0.0.1',
    port, // POS 창구(/pos/*)와 토스 웹훅. 프록시·터널은 이 포트만 넘긴다
    adminPort: Number(text('ADMIN_PORT')) || port + 1, // 정비 전산 흉내 화면(인증 없음). 항상 127.0.0.1 에만 연다
    tossWebhookSecret: text('TOSS_WEBHOOK_SECRET'),
    tossAccessKey: text('TOSS_OPENAPI_ACCESS_KEY'),
    tossSecretKey: text('TOSS_OPENAPI_SECRET_KEY'),
    tossBaseUrl: text('TOSS_OPENAPI_BASE_URL') || DEFAULT_BASE_URL,
  };
}
