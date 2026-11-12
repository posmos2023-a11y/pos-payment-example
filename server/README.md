# 결제 연동 예제 서버

정비 전산 서버가 해야 할 일을 작은 Node.js 코드로 보여 주는 **예제**입니다. 그대로 운영에 쓰는 코드가 아니라, 어떤 일을 어떤 순서로 하는지 읽고 따라 만들기 위한 참고용입니다.

정비 전산 서버가 할 일:

1. 토스 POS 플러그인이 접속하는 창구(`/pos/ws`, `/pos/poll`, `/pos/events`)를 연다.
2. 전산에서 [담기]를 누르면 "이 작업의 POS 장바구니 최종 상태" 명령(`SYNC_CART`)을 만들어 POS 단말에 전달한다.
3. POS 결제 결과(`payment.paid`, `payment.cancelled`)를 받아 작업 상태에 반영한다.
4. 토스 결제 웹훅(`/toss/webhook`)을 받아 같은 규칙으로 반영한다(POS 탭이 닫혀 있어도 결제 결과를 놓치지 않기 위해).

## 구성

| 파일 | 하는 일 |
|---|---|
| `src/main.js` | 실행 진입점(`npm start`) |
| `src/server.js` | HTTP·WebSocket 서버, 라우팅, 인증, 정비 전산 흉내 화면용 내부 API |
| `src/hub.js` | 매장별 단말 목록, 활성 단말 1대, 명령 큐(전달·재전송·만료), 플러그인 메시지 처리, 롱폴링 |
| `src/payments.js` | 결제 반영 규칙(중복 제거, 금액 비교, 취소) |
| `src/toss.js` | 웹훅 서명 검증, Open API 주문 조회, 주문 응답 해석 |
| `src/webhook.js` | 검증된 웹훅 이벤트의 비동기 처리(주문 조회, 메모 재조회) |
| `src/store.js` | 메모리 저장소(DB 없음) |
| `src/shops.js`, `scripts/add-shop.js` | 매장·토큰 파일(`data/shops.json`) 관리 |
| `public/index.html` | 정비 전산 흉내 화면 |
| `tools/fake-pos.mjs` | 실제 POS 없이 서버를 시험하는 가짜 플러그인 |
| `tools/send-test-webhook.mjs` | 서명한 가짜 토스 웹훅 전송 도구 |
| `test/*.test.js` | 테스트(`npm test`) |

## 실행

Node.js 22.9 이상(24 권장)이 필요합니다.

```
npm install
npm start
```

브라우저에서 `http://127.0.0.1:8788` 을 엽니다(정비 전산 흉내 화면). 처음 실행하면 시험 매장 1개가 만들어지고 **매장 토큰이 콘솔에 한 번 출력**됩니다(`data/shops.json` 에도 저장). 매장을 더 추가하려면 `npm run add-shop -- "매장 이름"` 을 실행하고 서버를 다시 시작하세요. `data/` 폴더는 저장소나 배포물에 넣지 않습니다(`.gitignore` 에 있음).

서버는 포트를 두 개 엽니다.

| 포트 | 받는 것 | 어디에 여는가 |
|---|---|---|
| `PORT`(기본 8787) | POS 창구 `/pos/*`, 토스 웹훅 `/toss/webhook`, `/health` | `HOST`(기본 `127.0.0.1`). 프록시·터널로 밖에 내보내는 포트 |
| `ADMIN_PORT`(기본 `PORT`+1 = 8788) | 화면 `/` 과 내부 API `/api/*` | 항상 `127.0.0.1`. **프록시·터널로 넘기지 마세요** |

화면을 따로 여는 이유: 화면과 `/api/*` 는 인증이 없습니다. 리버스 프록시나 터널 뒤에서는 모든 요청이 `127.0.0.1` 에서 온 것처럼 보이므로 "이 PC 에서 온 요청인지"를 주소나 헤더로 가려낼 수 없습니다. 그래서 프록시가 넘기는 포트에는 화면을 아예 두지 않습니다. `HOST=0.0.0.0` 으로 열면 POS 창구가 외부에 노출되니 주의하세요. 이 화면은 흉내용이므로 **운영에서는 전산의 실제 기능으로 대체**하세요.

### 환경변수 (`.env.example` 참고, `.env` 파일로도 가능)

| 이름 | 기본값 | 설명 |
|---|---|---|
| `HOST` | `127.0.0.1` | 바인딩 주소 |
| `PORT` | `8787` | POS 창구·웹훅 포트 |
| `ADMIN_PORT` | `PORT`+1 | 정비 전산 흉내 화면 포트(항상 `127.0.0.1`) |
| `TOSS_WEBHOOK_SECRET` | 없음 | 토스 웹훅 서명 시크릿. 없으면 `/toss/webhook` 은 503 |
| `TOSS_OPENAPI_ACCESS_KEY`, `TOSS_OPENAPI_SECRET_KEY` | 없음 | 주문 조회용 키. 없으면 승인 웹훅은 처리하지 않고(경고만), 취소 웹훅은 결제 ID·주문 ID 로만 처리. **없으면 단말의 결제 알림을 확인 없이 반영하는 시험 모드**가 됩니다(아래 "결제 반영 규칙") |
| `TOSS_OPENAPI_BASE_URL` | `https://open-api.tossplace.com/api-public/openapi/v1` | Open API 주소 |

## 가짜 POS 로 시험

서버를 띄운 뒤 다른 터미널에서(토큰은 콘솔 출력 또는 `data/shops.json`):

```
node tools/fake-pos.mjs --token <매장 토큰> --pay
```

화면에서 작업을 만들고 [담기]를 누르면 가짜 POS 가 명령을 받아 ack 하고(작업의 POS 상태가 "POS 에 담김"), `--pay` 면 잠시 뒤 `payment.paid` 를 보내 작업이 **결제완료**가 됩니다. 옵션: `--paid-value <원>`(금액 불일치 → 확인 필요), `--fail`(ack 실패), `--no-ack`(30초 재전송 시험), `--merchant-id <id>`(웹훅 시험용 가맹점 ID), 실행 중 `cancel` 입력(결제 취소 전송). 자세한 옵션은 파일 맨 위 주석을 보세요. 가짜 POS 는 WebSocket 만 씁니다(HTTP 경로는 `npm test` 에서 확인).

### 웹훅 서명 시험

```
set TOSS_WEBHOOK_SECRET=demo        (서버를 이 값으로 실행)
node tools/send-test-webhook.mjs --secret demo            -> 200
node tools/send-test-webhook.mjs --secret demo --tamper   -> 401
```

승인 웹훅을 실제로 반영하려면 Open API 키와, hello 로 `merchantId` 를 알려 준 매장이 필요합니다.

## 실제 POS 로 시험

토스 개발자센터 등록(POS 플러그인·Open API 앱), ACL·웹훅 설정은 요청 측에서 진행하고 웹훅 시크릿과 Open API 키를 전달합니다. 아래 두 절은 개발 중에 직접 시험해 보실 때의 절차입니다.

POS 는 인터넷으로 접속하므로 **외부에서 접근 가능한 https 주소**가 필요합니다(리버스 프록시나 터널로 이 서버의 `PORT`(8787)만 연결. 화면 포트 8788 은 연결하지 않음. 프록시는 WebSocket 업그레이드를 통과시켜야 함).

1. 토스 개발자센터 ACL 에 `https://<도메인>` 과 `wss://<도메인>` 을 등록합니다.
2. POS 플러그인 설정에 기준 주소(`https://<도메인>`)와 매장 토큰을 입력합니다.
3. 가맹점이 POS 서비스 연동 화면에서 서비스 코드를 입력합니다.

## 토스 웹훅 등록

토스 개발자센터 → Open API 앱 → 웹훅에서 주소 `https://<도메인>/toss/webhook`, 이벤트 **결제 승인(`payment.payment.approved.v1`)·결제 취소(`payment.payment.cancelled.v1`)** 를 선택하고, 발급된 시크릿을 `TOSS_WEBHOOK_SECRET` 에 넣습니다.

웹훅 처리: 서명(`x-toss-signature` = `v1=` + HMAC-SHA256(`시크릿`, `x-toss-timestamp` + `.` + 원본 body))을 원본 바이트로 검증 → 헤더 없음/시각 오차 5분 초과 400, 서명 틀림 401, 시크릿 없음 503, 본문 1MB 초과 413 → 같은 `x-toss-webhook-id` 는 200 만 응답 → 바로 200 을 주고 비동기로 처리합니다. 승인은 Open API 로 주문을 조회해 항목 메모 `#작업ID`에서 작업을 찾습니다(메모가 없으면 30초 뒤 한 번 더 조회). 취소는 주문을 다시 조회해 남은 결제 합이 0 이면 취소(환불), 아니면 확인 필요로 둡니다. 매장은 hello 로 받아 저장한 `merchantId` 로 찾습니다.

## 엔드포인트와 메시지 요약

메시지별 필드·기본값·전달 보장 규칙의 기준 문서는 저장소 루트의 [`PROTOCOL.md`](../PROTOCOL.md) 입니다. 아래는 요약입니다.

모든 `/pos/*` 는 `Authorization: Bearer <매장 토큰>` 필요(틀리면 401 `{"error":"UNAUTHORIZED"}`, WebSocket 은 업그레이드 전에 거절). CORS 헤더를 붙이고 `OPTIONS` 는 204.

| 경로 | 설명 |
|---|---|
| `WS /pos/ws` | 서버는 `hello` 를 받기 전에는 아무것도 보내지 않고, `hello` 마다 `welcome` 응답. 25초마다 `ping{t}`, 단말이 70초 동안 무응답이면 끊음. 같은 clientId 의 새 소켓이 hello 하면 이전 소켓을 닫음. 모르는 쿼리(`c=`)는 무시 |
| `GET /pos/poll?clientId=&wait=` | 롱폴링. wait 상한 25초, 명령 최대 20개, `{"commands":[...]}`. 열린 WebSocket 이 있는 단말에는 명령을 주지 않음 |
| `POST /pos/events` | `{clientId, messages:[...]}` → `{ok:true, replies:[...]}` (한 번에 최대 200개) |
| `POST /toss/webhook` | 토스 결제 웹훅 |

서버 → 플러그인: `welcome`, `command`(`SYNC_CART`: `workOrderId, label, lines[{key, productCode, title, category, unitPrice, quantity, taxFree}], startPayment, exclusive`), `ping`, `error`.
플러그인 → 서버: `hello`(`processedIds`, `merchantId`), `ack`, `draft`, `payment.paid`, `payment.cancelled`, `pong`, `log`.

라인 key 는 `gm-{작업ID}-{라인ID}`(작업ID 는 양의 정수, `_` 금지)이고, `lines` 는 증분이 아니라 **그 작업의 최종 상태 전체**입니다. 빈 배열이면 POS 에서 뺍니다.

명령 상태: `PENDING → SENT → DONE/FAILED`. `SENT` 후 ack 없이 30초면 `PENDING` 으로 되돌려 재전송, 30분이 지나면 `EXPIRED`, 같은 작업의 `PENDING` `SYNC_CART` 는 새 명령이 생기면 `SUPERSEDED`(`startPayment`·`exclusive` 는 OR 로 합침, 새 lines 가 비면 false), hello 의 `processedIds` 에 있는 명령은 `DONE`. 매장마다 활성 단말 1대에만 보내고, 활성 단말이 끊겨도 20초는 유지한 뒤 온라인인 다른 단말로 넘깁니다.

결제 반영 규칙(`src/payments.js`):

- **단말 보고를 얼마나 믿는가**: Open API 키가 있으면 단말의 `payment.paid` 는 "결제가 있었다"는 신호로만 쓰고, 그 결제 ID·주문 ID 로 토스에 주문을 조회해 확인한 금액과 항목 메모의 `#작업ID` 로 반영합니다(승인 웹훅과 같은 경로). 단말이 보낸 금액·작업 번호는 쓰지 않으므로 매장 토큰만으로는 결제완료를 만들 수 없습니다. 키가 없으면(로컬 시험) 단말이 보낸 값을 그대로 반영합니다. **운영에서는 키 없이 쓰지 마세요.**
- `(종류, paymentId)` 는 출처 등급마다 한 번만 반영. 단말이 보낸 값 그대로는 1등급, 토스로 확인한 값(웹훅, 주문 조회로 확인한 단말 보고)은 2등급입니다. 단말이 작업 번호나 금액 없이 먼저 보고한 결제도, 같은 결제의 2등급 결과가 한 번은 바로잡습니다. 같은 등급의 되풀이(플러그인의 재전송)는 버립니다.
- 이미 취소가 처리된 `paymentId` 의 `payment.paid` 는 반영하지 않습니다(승인 처리가 늦어져 취소보다 뒤에 온 경우).
- `payment.paid`: `workOrderIds` 가 비면 기록만. 이미 결제완료인 작업은 무시. `fullyPaid` 이고 `paidValue` 가 작업 합계와 같으면 **결제완료**, 다르면 **확인 필요**(사유 표시). `fullyPaid` 가 아닌데 `unpaidValue < 0` 이면 확인 필요. 그 밖의 부분 결제는 기록만.
- `payment.cancelled`: paymentId 로 작업을 찾고 없으면 orderId 로 찾아 결제완료였던 작업을 **취소(환불)** 로. 확인 필요였던 작업은 경고만 풀어 결제대기로.
- 취소(환불)·결제대기 작업은 다시 [담기] 가능, 결제완료 작업은 [담기] 거부(409). 확인 필요 작업은 화면의 [결제완료로 처리] 로 직원이 확정할 수 있음.

## 운영 전환 시 바꿀 것

- **저장소**: `src/store.js` 의 메모리 저장을 DB 로 교체(매장, 작업, 명령 큐, 처리한 결제 ID, 웹훅 id, 이벤트 로그). 서버를 다시 시작하면 지금은 모든 기록이 사라집니다.
- **토큰**: 평문 파일 대신 DB 에 해시로 저장, 매장별 발급·폐기 화면 제공.
- **관리 화면**: `public/index.html` 과 `/api/*` 는 인증 없는 흉내용입니다. 전산의 실제 화면·권한 체계로 대체하세요. 인증 없는 기능을 POS 창구와 같은 포트에 두지 마세요.
- **결제 확인**: Open API 키를 반드시 넣어, 단말의 결제 알림을 토스에서 확인한 뒤에 반영하게 하세요.
- **명령 전달 분산**: 서버가 여러 대이면 명령 큐와 활성 단말 상태를 공유 저장소로 옮기고 새 명령을 알리는 방법(알림·폴링)이 필요합니다. 이 예제는 한 프로세스만 가정합니다.
- **웹훅 재시도·로그**: 주문 조회 실패 시 재시도(예제는 최대 3회), 결제 이벤트 감사 로그, 알림을 운영 환경에 맞게 보강하세요. 키·토큰·시크릿은 로그에 남기지 마세요.
- **HTTPS**: 서버 앞에 TLS 를 끝내는 프록시를 두고 `HOST` 는 `127.0.0.1` 로 유지하세요.
