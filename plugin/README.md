# 정비 결제 연동 예제 (토스 POS 플러그인)

정비 전산에서 [담기]한 작업을 토스 POS 장바구니에 넣고 결제 화면을 여는 **토스 POS 탭 플러그인 예제**입니다. 결제가 끝나거나 취소되면 그 결과를 정비 전산 서버에 알립니다. 화면은 [결제]와 [설정] 두 개뿐이고, 결제와 관련 없는 기능은 없습니다.

통신 규약(메시지 종류와 필드)은 저장소 루트의 [`PROTOCOL.md`](../PROTOCOL.md)를 따르고, 타입 정의는 `src/payment/protocol.ts`에 있습니다. 이 README는 코드에 있는 동작만 설명합니다.

## 구성

| 경로 | 역할 |
|------|------|
| `src/main.tsx` | 진입점. React 화면을 붙입니다 |
| `src/App.tsx` | [결제]/[설정] 탭. 탭이 열리면 결제 연동을 시작하고, 페이지가 숨겨지거나 닫히면 멈춥니다 |
| `src/sdk.ts` | 실제 토스 SDK(`@tossplace/pos-plugin-sdk`)를 얇은 인터페이스에 연결하는 **유일한** 파일입니다. 브리지에 설정값을 읽어 주는 부분도 여기 있습니다 |
| `src/sdk-types.ts` | 화면 코드가 쓰는 최소 인터페이스(storage, secureStore, toast) |
| `src/screens/Payment.tsx` | [결제] 화면: 연결 상태, 지금 POS 장바구니의 정비 항목, [결제 화면 열기], 최근 처리 내역, 최근 결제 알림, [결제 다시 확인] |
| `src/screens/Settings.tsx` | [설정] 화면: 서버 주소, 매장 토큰, 결제 옵션 4개, 연결 확인 |
| `src/lib/settings-store.ts` | 설정 저장/불러오기와 브리지용 설정값 만들기 |
| `src/lib/use-bridge-view.ts` | 브리지 상태를 React 상태로 구독 |
| `src/lib/format.ts`, `src/lib/errors.ts` | 금액·시각 표시, 오류 문구 |
| `src/payment/runtime.ts` | 결제 연동의 수명(start/stop/applySettings). SDK 이벤트는 만들 때 한 번만 등록합니다 |
| `src/payment/bridge.ts` | 핵심 로직: 전산 명령 처리, POS 임시 주문(draftOrder) 조정, 결제 이벤트 보고 |
| `src/payment/transport.ts` | 전송 계층: WebSocket / HTTP 폴링 / 자동 |
| `src/payment/protocol.ts` | 메시지 타입, 검증, key 규칙 등 순수 함수 |
| `src/payment/lineitem.ts` | `addLineItem` 에 넘기는 DTO 만들기 |
| `src/payment/paywatch.ts` | 결제 대기 기록(결제 화면을 열기 전에 저장) |
| `src/payment/reconcile.ts` | 탭을 다시 열 때 놓친 결제 찾기 |
| `src/payment/settings.ts` | 설정값 정규화(주소, `/pos/ws` 주소 만들기) |
| `src/payment/activity.ts` | 최근 처리 내역(최근 20개) |
| `src/payment/clock.ts`, `src/payment/sdk-types.ts` | 시계 추상화, 브리지가 쓰는 SDK 최소 인터페이스 |
| `public/iframe-manifest.json` | 토스 POS 탭 메타 정보 |
| `scripts/make-zip.mjs` | 업로드용 zip 생성과 검증 |
| `test/` | 테스트(`node --test`). `test/payment/fake-sdk.ts` 가짜 SDK 로 브리지를 검증합니다 |

## 개발·빌드

Node.js 와 npm 이 필요합니다(이 예제는 Node 24 에서 확인했습니다).

```
npm install        # 의존성 설치(버전 정확 고정)
npm run typecheck  # 타입 검사
npm test           # 테스트
npm run build      # dist/ 생성(bundle.js, style.css, index.html, iframe-manifest.json)
npm run zip        # ../release/payment-example-plugin-<version>.zip 생성과 검증
npm run release    # typecheck + test + build + zip 을 차례로
```

- 빌드 결과는 `<script defer src="./bundle.js">` 로 읽는 IIFE 한 파일과 `style.css` 입니다(`base: './'`, 하위 폴더 없음). ES 모듈 방식은 쓰지 않습니다.
- zip 은 `dist/` 폴더로 감싼 구조(`dist/index.html`, `dist/iframe-manifest.json`, `dist/bundle.js`, `dist/style.css`)입니다. 토스 개발자센터 업로드 요구 사항이므로 바꾸지 마세요. `scripts/make-zip.mjs` 가 만든 뒤 다시 읽어 구조와 CRC 를 검증합니다.
- 결과물은 저장소 루트의 `release/payment-example-plugin-1.0.0.zip` 입니다(`plugin/` 의 한 단계 위 폴더).

## 토스 개발자센터 등록

토스 개발자센터 등록, ACL 설정, 개발 배포와 테스트, 검수·배포는 요청 측에서 진행합니다. 아래는 개발 중에 직접 시험해 보실 때의 절차입니다.

1. 개발자센터에서 POS 플러그인을 만들고 위 zip 을 업로드합니다.
2. **ACL(통신 허용 목록)** 에 정비 전산 서버 주소를 **프로토콜까지** 등록합니다.
   - 운영: `https://서버주소` 와 `wss://서버주소`
   - 로컬 시험: `http://서버주소:포트` 와 `ws://서버주소:포트`
   - 프로토콜이 빠지거나 다르면 호스트가 연결을 막습니다. HTTP 폴링으로 전환될 때를 위해 `https://`(또는 `http://`)도 함께 등록해야 합니다.
3. 플러그인을 매장에 설치한 뒤 POS 의 탭 목록에서 "정비 결제 연동(예제)" 를 엽니다.

## 매장 설정

[설정] 화면에서 입력하고 [저장]을 누릅니다. 저장하면 연동이 설정을 다시 읽습니다(`bridge.reloadSettings()`).

| 항목 | 저장 위치 | 설명 |
|------|-----------|------|
| 정비 전산 서버 주소 | storage `gm.serverUrl` | `https://` 주소를 씁니다. 매장 토큰이 요청마다 실리므로 스킴을 빼면 `https://` 를 붙이고, 이 PC·내부망 주소(`localhost`, `127.x`, `10.x`, `172.16~31.x`, `192.168.x`)일 때만 `http://` 를 붙입니다(로컬 시험용). `ws://`·`wss://` 를 붙여 넣으면 `http(s)://` 로 바꿉니다. 기본값은 비어 있습니다 |
| 매장 토큰 | secureStore `gm.token` | 정비 전산이 발급한 토큰. 요청에 `Authorization: Bearer` 로 실립니다 |
| 담으면 바로 결제 화면 열기 | storage `gm.allowStartPayment` | 기본 켜짐 |
| POS 상품코드 매칭 | storage `gm.matchCatalog` | 기본 켜짐 |
| 기본 상품 코드 | storage `gm.defaultItemCode` | 상품코드가 맞는 POS 상품이 없을 때 밑판으로 쓸 상품(선택). 없으면 판매 중(ON_SALE) 첫 상품을 씁니다 |
| 알림 표시 | storage `gm.showToast` | 기본 켜짐 |

서버 주소나 매장 토큰 중 하나라도 비어 있으면 연동을 시작하지 않고, [결제] 화면에 "설정에서 서버 주소와 매장 토큰을 넣어 주세요" 가 보입니다. 이미 연결돼 있다가 둘 중 하나를 비우고 저장하면 연동이 멈춥니다.

## 동작 요약

### 연결
- 연결 방식은 항상 **자동**입니다. 먼저 WebSocket(`ws(s)://서버주소/pos/ws`)으로 붙고, 한 번도 `welcome` 을 받지 못한 채 연속 3회 실패하면 HTTP 폴링(`/pos/poll`, 보고는 `/pos/events`)으로 바꿉니다. HTTP 폴링 중에는 10분마다 WebSocket 을 다시 시도합니다.
- 연결하면 `hello` 를 보내고 서버의 `welcome` 을 기다립니다. [설정]의 "연결 확인"은 `welcome` 을 받았는지를 보여 줍니다.
- 토큰이 거절되면(HTTP 401) "매장 토큰이 맞지 않아요" 알림이 뜹니다.

### SYNC_CART 처리
- 서버가 보낸 작업(`SYNC_CART`)의 상품 줄들을 POS 장바구니(draftOrder)에 반영합니다. "POS 상품코드 매칭"이 켜져 있으면 POS 카탈로그에서 상품코드가 같은 상품을 바탕으로 품목을 만들고, 없으면 기본 상품 코드의 상품, 그것도 없으면 판매 중 첫 상품을 바탕으로 합니다. 이름·금액만 정비 항목 값으로 바꿉니다.
- 전산이 주는 논리 key(`gm-{작업ID}-{라인ID}`)와 POS 에 넣는 key 는 다릅니다. POS key = 논리 key + `_` + 8자(영숫자)이고, 줄을 담을 때마다 새로 만듭니다. 서버와 주고받는 메시지에는 항상 논리 key 를 씁니다.
- 명령을 처리할 때는 캐시한 장바구니를 믿지 않고 시작할 때와 끝날 때 `draftOrder.get()` 으로 실제 상태를 읽습니다. 결제 화면을 열기 전에 `draftOrder.get()` 으로 다시 읽어 장바구니가 서버가 보낸 내용과 같은지 검증합니다. 다르면 한 번 더 맞춰 보고, 그래도 다르면 오류로 처리하며 결제 화면을 열지 않습니다.
- "담으면 바로 결제 화면 열기"가 켜져 있으면 담은 뒤 결제 화면을 엽니다. [결제] 화면의 [결제 화면 열기]로도 열 수 있습니다.
- 처리 결과(담았어요/비웠어요/결제 시작/실패/건너뜀)는 [결제] 화면의 "최근 처리 내역"에 최근 20개까지 남습니다.

### 결제 결과 보고와 놓친 결제 찾기
- 결제 화면(`startPayment`)을 열기 **전에** "이 작업들을 결제하러 갔다"는 결제 대기 기록과 "이 명령을 처리했다"는 처리 이력을 storage 에 저장합니다. 결제 화면이 열리면 탭이 다시 로드될 수 있는데, 처리 이력이 남아 있어야 서버가 같은 명령을 다시 보내도 또 담고 결제 화면을 또 여는 일이 없습니다.
- 결제 완료·취소 이벤트를 받으면 주문(`getOrder`)을 조회해(최대 3회 시도) 서버에 `payment.paid` / `payment.cancelled` 로 알립니다.
- 그 결제가 어느 작업의 것인지는 **결제된 주문의 항목 메모(`#작업ID`)** 로 정합니다. 그 순간 장바구니에 무엇이 담겨 있었는지는 기준이 아닙니다(다른 주문의 결제가 담겨 있던 작업에 붙으면 안 됩니다). 주문을 조회하지 못했거나 응답에 항목 목록이 없을 때만 장바구니 기억을 대신 씁니다. 보낸 결제 알림은 보존해 두었다가 연결이 다시 되어 `welcome` 을 받을 때마다 다시 보냅니다. 같은 결제는 중복 처리하지 않습니다.
- 탭이 다시 열려 처음 `welcome` 을 받으면 결제 대기 기록을 보고 `order.getOrders` 로 최근 주문을 조회해 놓친 결제를 찾아 보고합니다. [결제] 화면의 [결제 다시 확인]으로 직접 실행할 수도 있습니다.

### 서버가 웹훅으로도 결제를 확인해야 하는 이유
결제 화면이 열리면 플러그인 탭이 가려지거나 다시 로드될 수 있습니다. 그 사이에 끝난 결제는 플러그인이 즉시 보고하지 못할 수 있고, 탭을 다시 열어야 위의 "놓친 결제 찾기"가 동작합니다. 따라서 정비 전산 서버는 플러그인의 보고에만 의존하지 말고 **토스 웹훅으로도 결제를 확인**해야 합니다.

## 의존성 (정확한 버전 고정)

`@tossplace/pos-plugin-sdk` 0.0.31, `react` / `react-dom` 19.3.1, `typescript` 7.0.2, `vite` 8.3.8, `@vitejs/plugin-react` 6.3.0, `@types/node` 26.6.6, `@types/react` / `@types/react-dom` 19.3.0
