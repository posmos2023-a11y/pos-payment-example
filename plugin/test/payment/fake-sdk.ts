// 테스트용 가짜 SDK: 임시 주문을 메모리로 흉내 내고, 모든 호출을 기록한다.
import type {
  CatalogItemLike,
  CategoryLike,
  DraftLike,
  DraftLineItemLike,
  HttpResponseLike,
  LineItemDto,
  OrderDetailLike,
  OrderLike,
  SdkLike,
  SettingInput,
  SettingValue,
  WebsocketLike,
} from '../../src/payment/sdk-types.ts';
import { logicalKeyOf } from '../../src/payment/protocol.ts';

/** 실제 SDK 의 PosPluginSdkRateLimitError 와 같은 모양(정적 판별 함수 + 한국어 메시지) */
export class FakeRateLimitError extends Error {
  constructor(message = '해당 기능은 60초당 100회만 호출할 수 있습니다') {
    super(message);
  }
  static isPosPluginSdkRateLimitError(e: unknown): boolean {
    return e instanceof FakeRateLimitError;
  }
}

export interface Call {
  name: string;
  args: unknown[];
}

export interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

export function deferred<T = void>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// ---- WebSocket ------------------------------------------------------------

export class FakeWs implements WebsocketLike {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly options: unknown;
  sent: Record<string, unknown>[] = [];
  connectCalls = 0;
  disconnectCalls = 0;
  failSend = false;
  /** 설정하면 disconnect() 가 이 오류로 거절된다 */
  disconnectError: Error | null = null;
  onMessageCb: ((m: string) => void) | undefined;
  onErrorCb: ((n?: string, m?: string) => void) | undefined;
  onCloseCb: ((c: string) => void) | undefined;
  onOpenCb: (() => void) | undefined;

  constructor(url: string, headers: Record<string, string>, options: unknown) {
    this.url = url;
    this.headers = headers;
    this.options = options;
  }

  connect(): Promise<void> {
    this.connectCalls++;
    return Promise.resolve();
  }
  disconnect(): Promise<void> {
    this.disconnectCalls++;
    return this.disconnectError ? Promise.reject(this.disconnectError) : Promise.resolve();
  }
  send(data: { data: string; option?: { mask?: boolean } }): void {
    if (this.failSend) throw new Error('send failed');
    this.sent.push(JSON.parse(data.data) as Record<string, unknown>);
  }
  onMessage(cb: (m: string) => void): void {
    this.onMessageCb = cb;
  }
  onError(cb: (n?: string, m?: string) => void): void {
    this.onErrorCb = cb;
  }
  onClose(cb: (c: string) => void): void {
    this.onCloseCb = cb;
  }
  onOpen(cb: () => void): void {
    this.onOpenCb = cb;
  }

  // 테스트용 조작
  serverSend(obj: unknown): void {
    this.onMessageCb?.(typeof obj === 'string' ? obj : JSON.stringify(obj));
  }
  serverClose(code = '1006'): void {
    this.onCloseCb?.(code);
  }
  /** 호스트가 소켓이 열렸다고 알리는 `open` 이벤트 */
  serverOpen(): void {
    this.onOpenCb?.();
  }
  serverError(name = 'Error', message = 'boom'): void {
    this.onErrorCb?.(name, message);
  }
  sentOfType(type: string): Record<string, unknown>[] {
    return this.sent.filter((m) => m.type === type);
  }
}

/** create() 한 번에 대한 계획: 'ok' | Error(거부) | 함수(await 후 성공, throw 하면 실패) */
export type CreatePlan = 'ok' | Error | (() => Promise<void>);

// ---- HTTP -----------------------------------------------------------------

export interface HttpRequestRecord {
  method: 'GET' | 'POST';
  url: string;
  headers: [string, string][];
  payload?: unknown;
  options?: { timeoutMs?: number };
}

export type HttpHandler = (req: HttpRequestRecord) => Promise<HttpResponseLike> | HttpResponseLike;

export function jsonResponse(code: number, body: unknown): HttpResponseLike {
  return { code, headers: [], body: typeof body === 'string' ? body : JSON.stringify(body) };
}

// ---- 임시 주문 모델 ---------------------------------------------------------

export interface FakeLine extends DraftLineItemLike {}

export class FakeSdk implements SdkLike {
  calls: Call[] = [];

  // draftOrder
  lines: FakeLine[] = [];
  keyMode: 'preserve' | 'rewrite' = 'preserve';
  emitUpdates = true;
  /** 앞으로 변경 메서드 N번은 "변경 전" draft 를 돌려준다(POS 응답이 늦게 반영된 상태 흉내). get()/이벤트는 정상. */
  lateReturns = 0;
  /** 설정하면 get() 이 돌려주는 draft 를 이 함수로 바꾼다(검증이 계속 실패하는 POS 흉내) */
  getTransform?: (d: DraftLike) => DraftLike;
  hooks: {
    get?: () => void | Promise<void>;
    addLineItem?: (dto: LineItemDto) => void | Promise<void>;
    deleteLineItem?: (key: string) => void | Promise<void>;
    updateItemQuantity?: (key: string, qty: number) => void | Promise<void>;
    startPayment?: () => void | Promise<void>;
  } = {};
  private keySeq = 0;
  private updateHandlers: Array<(d: DraftLike) => void> = [];

  // websocket
  sockets: FakeWs[] = [];
  /** true 면 앞으로 만들어지는 소켓의 send() 가 던진다(소켓이 아직 안 열렸을 때의 호스트 오류 흉내) */
  newSocketsFailSend = false;
  createPlan: CreatePlan[] = [];
  createRequests: { url: string; headers: Record<string, string>; options: unknown }[] = [];

  // http
  requests: HttpRequestRecord[] = [];
  httpHandler: HttpHandler = () => jsonResponse(200, {});

  // storage
  store = new Map<string, string>();
  failStorage = false;

  // toast
  toasts: { kind: 'success' | 'warn' | 'error'; message: string }[] = [];

  // setting
  settingInputs: SettingInput[] | null = null;
  settingValues: Record<string, SettingValue> = {};
  private settingHandlers: Array<() => void> = [];

  // catalog / category / order
  /** 기본으로 판매 중 상품 하나가 있다(전산 상품은 항상 POS 상품을 밑판으로 쓰기 때문) */
  catalogItems: CatalogItemLike[] = [catalogItem({ id: 900, title: '기본 상품', code: 'BASE-DEFAULT' })];
  catalogHook?: () => void | Promise<void>;
  catalogHandlers: Array<(id: number) => void> = [];
  categoryList: CategoryLike[] = [{ id: 7, title: '기타' }];
  categoryHook?: () => void | Promise<void>;
  orders = new Map<string, OrderLike>();
  orderHook?: (id: string) => void | Promise<void>;
  /** order.getOrders 가 돌려줄 주문 목록 */
  ordersList: OrderDetailLike[] = [];
  /** getOrders 가 앞에서부터 차례로 던질 오류(비면 정상 동작) */
  getOrdersFailures: unknown[] = [];
  /** getMerchant 결과(Error 면 거절) */
  merchant_: { id: number } | Error = { id: 4242 };
  /** getOrder 가 앞에서부터 차례로 던질 오류(비면 정상 동작) */
  orderFailures: unknown[] = [];
  paymentHandlers: { paid: Array<(p: string, o: string) => void>; cancel: Array<(p: string, o: string) => void> } = {
    paid: [],
    cancel: [],
  };
  pluginInfo = { name: 'payment-example-test-plugin', version: '9.9.9' };
  errorHandlers: Array<(e: Error) => void> = [];

  // ---- SdkLike 구현 ---------------------------------------------------------

  draftOrder: SdkLike['draftOrder'] = {
    on: (_event, cb) => {
      this.updateHandlers.push(cb);
    },
    get: async () => {
      this.record('draftOrder.get', []);
      await this.hooks.get?.();
      const d = this.snapshot();
      return this.getTransform ? this.getTransform(d) : d;
    },
    addLineItem: async (dto) => {
      this.record('draftOrder.addLineItem', [structuredClone(dto)]);
      await this.hooks.addLineItem?.(dto);
      const before = this.snapshot();
      const key = this.keyMode === 'preserve' ? dto.key : `pos-${++this.keySeq}`;
      this.lines.push({
        key,
        item: {
          id: dto.item.id,
          title: dto.item.title,
          category: dto.item.category,
          ...(dto.item.code !== undefined ? { code: dto.item.code } : {}),
        },
        itemPrice: {
          priceValue: dto.itemPrice.priceValue,
          ...((dto.itemPrice as { sku?: string }).sku !== undefined ? { sku: (dto.itemPrice as { sku?: string }).sku } : {}),
        },
        quantity: dto.quantity,
      });
      return this.afterChange(before);
    },
    deleteLineItem: async (key) => {
      this.record('draftOrder.deleteLineItem', [key]);
      await this.hooks.deleteLineItem?.(key);
      const idx = this.lines.findIndex((l) => l.key === key);
      if (idx < 0) throw new Error(`no such line: ${key}`);
      const before = this.snapshot();
      this.lines.splice(idx, 1);
      return this.afterChange(before);
    },
    updateItemQuantity: async (key, qty) => {
      this.record('draftOrder.updateItemQuantity', [key, qty]);
      await this.hooks.updateItemQuantity?.(key, qty);
      const line = this.lines.find((l) => l.key === key);
      if (!line) throw new Error(`no such line: ${key}`);
      line.quantity = qty;
      return this.afterChange();
    },
    startPayment: async () => {
      this.record('draftOrder.startPayment', []);
      await this.hooks.startPayment?.();
    },
  };

  websocket: SdkLike['websocket'] = {
    create: async (url, headers, options) => {
      this.record('websocket.create', [url, headers, options]);
      this.createRequests.push({ url, headers, options });
      const plan = this.createPlan.shift() ?? 'ok';
      if (plan instanceof Error) throw plan;
      if (typeof plan === 'function') await plan();
      const ws = new FakeWs(url, headers, options);
      ws.failSend = this.newSocketsFailSend;
      this.sockets.push(ws);
      return ws;
    },
  };

  http: SdkLike['http'] = {
    get: async (url, headers, options) => {
      const req: HttpRequestRecord = { method: 'GET', url, headers: headers ?? [], options };
      this.requests.push(req);
      this.record('http.get', [url]);
      return await this.httpHandler(req);
    },
    post: async (url, payload, headers, options) => {
      const req: HttpRequestRecord = {
        method: 'POST',
        url,
        headers: headers ?? [],
        payload: structuredClone(payload),
        options,
      };
      this.requests.push(req);
      this.record('http.post', [url]);
      return await this.httpHandler(req);
    },
  };

  storage: SdkLike['storage'] = {
    get: async (key) => {
      this.record('storage.get', [key]);
      if (this.failStorage) throw new Error('storage down');
      return this.store.get(key);
    },
    set: async (key, value) => {
      this.record('storage.set', [key]);
      if (this.failStorage) throw new Error('storage down');
      this.store.set(key, value);
    },
    del: async (key) => {
      this.record('storage.del', [key]);
      this.store.delete(key);
    },
  };

  toast: SdkLike['toast'] = {
    error: ({ message }) => {
      this.toasts.push({ kind: 'error', message });
    },
    warn: ({ message }) => {
      this.toasts.push({ kind: 'warn', message });
    },
    success: ({ message }) => {
      this.toasts.push({ kind: 'success', message });
    },
  };

  setting: SdkLike['setting'] = {
    setInputs: async (inputs) => {
      this.record('setting.setInputs', [inputs]);
      this.settingInputs = inputs;
    },
    getValues: async <T extends Record<string, SettingValue>>() => {
      this.record('setting.getValues', []);
      return { ...this.settingValues } as T;
    },
    on: (_event, cb) => {
      this.settingHandlers.push(cb);
    },
  };

  catalog: SdkLike['catalog'] = {
    getCatalogs: async () => {
      this.record('catalog.getCatalogs', []);
      await this.catalogHook?.();
      return this.catalogItems;
    },
    on: (_event, cb) => {
      this.catalogHandlers.push(cb);
    },
  };

  category: SdkLike['category'] = {
    getCategories: async () => {
      this.record('category.getCategories', []);
      await this.categoryHook?.();
      return this.categoryList;
    },
  };

  order: SdkLike['order'] = {
    getOrder: async (id) => {
      this.record('order.getOrder', [id]);
      await this.orderHook?.(id);
      if (this.orderFailures.length > 0) throw this.orderFailures.shift();
      const o = this.orders.get(id);
      if (!o) throw new Error(`no such order: ${id}`);
      return o;
    },
    getOrders: async (params) => {
      this.record('order.getOrders', [params]);
      if (this.getOrdersFailures.length > 0) throw this.getOrdersFailures.shift();
      return this.ordersList;
    },
  };

  merchant: SdkLike['merchant'] = {
    getMerchant: async () => {
      this.record('merchant.getMerchant', []);
      if (this.merchant_ instanceof Error) throw this.merchant_;
      return this.merchant_;
    },
  };

  payment: SdkLike['payment'] = {
    on: (event, cb) => {
      this.paymentHandlers[event].push(cb);
    },
  };

  plugin: SdkLike['plugin'] = {
    getPluginInfo: async () => {
      this.record('plugin.getPluginInfo', []);
      return this.pluginInfo;
    },
  };

  error: SdkLike['error'] = {
    addErrorListener: (handler) => {
      this.errorHandlers.push(handler);
    },
  };

  // ---- 테스트용 도우미 --------------------------------------------------------

  private record(name: string, args: unknown[]): void {
    this.calls.push({ name, args });
  }

  callsOf(name: string): Call[] {
    return this.calls.filter((c) => c.name === name);
  }

  /** 호출 이름만 순서대로 */
  callNames(prefix = ''): string[] {
    return this.calls.map((c) => c.name).filter((n) => n.startsWith(prefix));
  }

  resetCalls(): void {
    this.calls = [];
  }

  snapshot(): DraftLike {
    const lineItems = this.lines.map((l) => structuredClone(l));
    const orderPriceValue = lineItems.reduce((s, l) => s + l.itemPrice.priceValue * l.quantity, 0);
    return { lineItems, price: { orderPriceValue } };
  }

  private afterChange(before?: DraftLike): DraftLike {
    const d = this.snapshot();
    if (this.emitUpdates) this.emitDraftUpdate();
    if (this.lateReturns > 0 && before) {
      this.lateReturns--;
      return before;
    }
    return d;
  }

  emitDraftUpdate(): void {
    const d = this.snapshot();
    for (const h of this.updateHandlers) h(d);
  }

  /** POS 에서 사용자가 직접 담은 라인(전산과 무관) */
  addManualLine(key: string, title: string, quantity = 1, priceValue = 1000, emit = false): void {
    this.lines.push({
      key,
      item: { id: 100, title, category: { id: 1, title: '직접' } },
      itemPrice: { priceValue },
      quantity,
    });
    if (emit) this.emitDraftUpdate();
  }

  lineKeys(): string[] {
    return this.lines.map((l) => l.key);
  }

  /** POS key 의 `_nonce` 를 뗀 논리 key(우리 key 가 아니면 그대로) */
  logicalKeys(): string[] {
    return this.lines.map((l) => logicalKeyOf(l.key) ?? l.key);
  }

  /** deleteLineItem 에 넘긴 key 들(논리 key 로) */
  deletedKeys(): string[] {
    return this.callsOf('draftOrder.deleteLineItem').map((c) => {
      const k = c.args[0] as string;
      return logicalKeyOf(k) ?? k;
    });
  }

  emitSettingChange(): void {
    for (const h of this.settingHandlers) h();
  }

  setOrder(id: string, unpaid: number, paid: number): void {
    this.orders.set(id, { paymentPrice: { paymentUnpaidValue: unpaid, paymentPaidValue: paid } });
  }

  emitPaid(paymentId: string, orderId: string): void {
    for (const h of this.paymentHandlers.paid) h(paymentId, orderId);
  }

  emitCancel(paymentId: string, orderId: string): void {
    for (const h of this.paymentHandlers.cancel) h(paymentId, orderId);
  }

  emitCatalogEvent(id = 1): void {
    for (const h of this.catalogHandlers) h(id);
  }
}

export function catalogItem(partial: Partial<CatalogItemLike> & { id: number; title: string }): CatalogItemLike {
  return {
    category: { id: 3, title: '소모품' },
    options: [],
    state: 'ON_SALE',
    price: { title: '기본', sku: undefined, barcode: undefined },
    ...partial,
  };
}
