// bridge / transport 가 의존하는 "최소 SDK 인터페이스".
//
// - 이 파일(과 bridge/transport/protocol/settings)은 런타임에 @tossplace/pos-plugin-sdk 를 import 하지 않는다.
//   (여기의 `import type` 은 타입 제거 시 완전히 사라진다. 그래서 테스트는 SDK 없이도 돈다.)
// - 실제 `posPluginSdk` 가 이 인터페이스에 대입 가능해야 한다. src/sdk.ts 의
//   SdkLike 대입을 tsc 가 검증한다.
import type { PluginCatalogItemOption } from '@tossplace/pos-plugin-sdk';

export type SettingValue = number | string | string[] | boolean | undefined;

export interface CategoryLike {
  id: number;
  title: string;
}

/** 읽기 전용으로만 쓰는 임시 주문 항목(실제 PluginDraftOrderItem 의 부분집합). */
export interface DraftLineItemLike {
  key: string;
  item: { id: number; title: string; category: CategoryLike; code?: string };
  itemPrice: { priceValue: number; sku?: string };
  quantity: number;
}

/** 읽기 전용으로만 쓰는 임시 주문(실제 PluginDraftOrder 의 부분집합). */
export interface DraftLike {
  lineItems: DraftLineItemLike[];
  price: { orderPriceValue: number };
}

/**
 * addLineItem 에 넘기는 DTO. 실제 PluginDraftOrderItemDto 와 서로 대입 가능해야 한다.
 * 실제 POS 에서는 item/itemPrice 를 POS 카탈로그 상품 원본 객체 전체를 밑판으로 만든다(bridge.makeDto).
 * 그래서 여기 적힌 필드 외에도 런타임에는 원본의 나머지 필드가 함께 들어간다.
 */
export interface LineItemDto {
  key: string;
  item: {
    id: number;
    title: string;
    category: CategoryLike;
    options: PluginCatalogItemOption[];
    code?: string;
    type: 'ITEM';
  };
  itemPrice: {
    title: string;
    priceType: 'FIXED';
    priceUnit: number;
    priceValue: number;
    isTaxFree: boolean;
    sku?: string;
  };
  quantity: number;
  /** '#작업ID 라벨'(80자 제한). undefined 금지(빈 값은 ''). */
  memo: string;
  discount: never[];
  optionChoices: never[];
  diningOption: 'HERE';
}

/** getCatalogs() 가 주는 상품. 실제 객체에는 이 밖의 필드(prices, metadata 등)가 더 있고 DTO 밑판으로 통째로 쓴다. */
export interface CatalogItemLike {
  id: number;
  code?: string;
  title: string;
  state?: string;
  category: CategoryLike;
  options: PluginCatalogItemOption[];
  price: { title: string; sku?: string; barcode?: string };
}

/** order.getOrder 가 돌려주는 주문의 읽기 전용 부분집합. */
export interface OrderLike {
  paymentPrice: { paymentUnpaidValue: number; paymentPaidValue: number };
  /** 주문 항목. 항목 메모('#작업ID 라벨')로 이 결제가 어느 작업의 것인지 알아낸다(bridge.onPaid). */
  lineItems?: { memo?: string }[];
}

/** order.getOrders 가 돌려주는 주문의 읽기 전용 부분집합(실제 PluginOrder 에 대입 가능해야 한다). */
export type OrderPaymentState = 'OPENED' | 'PAID' | 'CANCELLED' | 'COMPLETED' | 'REFUNDED';

export interface OrderDetailLike {
  id: string;
  paymentState: OrderPaymentState;
  lineItems: { memo?: string }[];
  payments: { id: string; state: string }[];
  paymentPrice: { paymentUnpaidValue: number; paymentPaidValue: number };
}

export interface HttpResponseLike {
  body: string;
  headers: [string, string][];
  code: number;
}

export interface HttpLike {
  get(
    url: string,
    headers?: [string, string][],
    options?: { timeoutMs?: number },
  ): Promise<HttpResponseLike>;
  post(
    url: string,
    payload: unknown,
    headers?: [string, string][],
    options?: { timeoutMs?: number },
  ): Promise<HttpResponseLike>;
}

export interface WebsocketLike {
  /** 사용 금지: websocket.create() 가 이미 connect() 를 호출한다(이중 연결 방지). */
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  send(data: { data: string; option?: { mask?: boolean } }): void;
  onMessage(callback: (message: string) => void): void;
  onError(callback: (errorName?: string, errorMessage?: string) => void): void;
  onClose(callback: (code: string) => void): void;
  onOpen(callback: () => void): void;
}

export interface StorageLike {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  del(key: string): Promise<void>;
}

export interface ToastLike {
  error(params: { message: string }): void;
  warn(params: { message: string }): void;
  success(params: { message: string }): void;
}

interface SettingInputBase {
  id: string;
  label: string;
  required: boolean;
}

export type SettingInput =
  | (SettingInputBase & { type: 'text'; default: string; placeholder?: string })
  | (SettingInputBase & { type: 'password'; default: string; placeholder?: string })
  | (SettingInputBase & {
      type: 'radio';
      default: string;
      values: { id: string; label: string }[];
    })
  | (SettingInputBase & { type: 'toggle'; default: boolean });

export interface SettingLike {
  setInputs: (inputs: SettingInput[]) => Promise<void>;
  getValues: <T extends Record<string, SettingValue>>() => Promise<T>;
  on: (event: 'change', callback: () => void) => void;
}

export interface SdkLike {
  draftOrder: {
    on(event: 'update', callback: (draftOrder: DraftLike) => void): void;
    get(): Promise<DraftLike>;
    addLineItem(lineItem: LineItemDto): Promise<DraftLike>;
    deleteLineItem(itemKey: string): Promise<DraftLike>;
    updateItemQuantity(itemKey: string, quantity: number): Promise<DraftLike>;
    startPayment(): Promise<void>;
  };
  websocket: {
    create(
      url: string,
      headers: Record<string, string>,
      options?: { rejectUnauthorized?: boolean; followRedirects?: boolean; timeout?: number },
    ): Promise<WebsocketLike>;
  };
  http: HttpLike;
  storage: StorageLike;
  toast: ToastLike;
  setting: SettingLike;
  catalog: {
    getCatalogs(): Promise<CatalogItemLike[]>;
    on(event: 'update' | 'add' | 'delete', callback: (id: number) => void): void;
  };
  category: {
    getCategories(): Promise<CategoryLike[]>;
  };
  order: {
    getOrder(id: string): Promise<OrderLike>;
    /** createdAt 기준 조회. 호출 제한(60초 100회·30분 200회 공유) 대상 */
    getOrders(params: { start: string; end: string; page?: number; size?: number }): Promise<OrderDetailLike[]>;
  };
  payment: {
    on(event: 'cancel' | 'paid', callback: (paymentId: string, orderId: string) => void): void;
  };
  merchant: {
    getMerchant(): Promise<{ id: number }>;
  };
  plugin: {
    getPluginInfo(): Promise<{ name: string; version: string }>;
  };
  error: {
    addErrorListener(handler: (error: Error) => void): void;
  };
}
