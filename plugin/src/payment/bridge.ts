// 핵심 로직: 전산 명령 처리 -> POS 임시 주문(DraftOrder) 조정, 결제 이벤트 보고.
// 정비 전산 명령(SYNC_CART·CLEAR_CART)을 POS 임시 주문에 반영하고 결제 결과를 전산에 보고한다. 결제 후 getOrder 는 최대 3회 시도. SDK 는 직접 import 하지 않고 sdk-types.ts 의 최소 인터페이스만 쓴다.
import type { Clock } from './clock.ts';
import { Sleeper } from './clock.ts';
import type {
  AckMessage,
  CartLine,
  Command,
  DraftSummary,
  HelloMessage,
  LogLevel,
  PaymentCancelledMessage,
  PaymentPaidMessage,
  PluginMessage,
  ServerMessage,
  SyncCartPayload,
  TransportKind,
} from './protocol.ts';
import {
  OUR_KEY_PREFIX,
  POS_NONCE_LENGTH,
  enqueueOutgoing,
  isOurKey,
  isPriorityMessage,
  logicalKeyOf,
  makeLineMemo,
  makePosKey,
  parseClearCartPayload,
  parseWorkOrderId,
  parseSyncCartPayload,
  summarizeDraft,
  summarySignature,
} from './protocol.ts';
import type { PluginSettings } from './settings.ts';
import { EMPTY_URL_WARNING, connectionChanged, normalizeSettings } from './settings.ts';
import { buildLineItemDto } from './lineitem.ts';
import type { CatalogItemLike, DraftLike, DraftLineItemLike, SdkLike, SettingValue } from './sdk-types.ts';
import type { Transport, TransportStatus } from './transport.ts';
import type { ActivityEntry, ActivityResult } from './activity.ts';
import { ACTIVITY_KEY, addActivity, parseActivity } from './activity.ts';
import { PaywatchStore } from './paywatch.ts';
import type { ReconcileResult } from './reconcile.ts';
import { reconcilePayments, workOrderIdsOf } from './reconcile.ts';

export const CLIENT_ID_KEY = 'gm.clientId';
/** 우리 key <-> POS key 연결(탭이 다시 로드돼도 우리 라인을 알아보게 한다). */
export const KEYMAP_KEY = 'gm.keymap';
export const KEYMAP_MAX = 200;
/** 토스 merchantId 캐시(hello 의 선택 필드). */
export const MERCHANT_ID_KEY = 'gm.merchantId';
export const NO_CATALOG_MESSAGE = 'POS에 등록된 상품이 하나 이상 있어야 해요';
export const PROCESSED_KEY = 'gm.processed';
/** 보낸 payment.paid / payment.cancelled 보존: 매 welcome 뒤에 전부 다시 보낸다. */
export const PAYMENTS_KEY = 'gm.payments';
export const PAYMENTS_MAX = 20;
export const PAYMENTS_MAX_AGE_MS = 24 * 60 * 60_000;
export const PROCESSED_MAX = 100;
export const HELLO_PROCESSED_MAX = 50;
export const RATE_LIMIT_WAIT_MS = 15_000;
export const RATE_LIMIT_MAX_RETRIES = 4;
/** 결제 후 getOrder 조회 최대 시도 횟수와, 호출 제한이 아닌 오류 뒤 대기 시간. */
export const PAYMENT_LOOKUP_ATTEMPTS = 3;
export const PAYMENT_LOOKUP_RETRY_MS = 5_000;
export const DRAFT_THROTTLE_MS = 2000;
/** draft 가 비워진 뒤에도 마지막 작업 ID 를 결제에 연결해 줄 시간. */
export const ATTRIB_WINDOW_MS = 5 * 60_000;
export const CATALOG_REFRESH_MS = 5 * 60_000;
export const OUTBOX_MAX = 100;
export const LOG_MAX_PER_MINUTE = 5;
const HANDLED_PAYMENTS_MAX = 200;
const AUTH_TOAST_INTERVAL_MS = 10 * 60_000;
const DEFAULT_PLUGIN_NAME = 'payment-example-plugin';
const RATE_LIMIT_MESSAGE_PART = '회만 호출할 수 있습니다';

/** transportFactory 에 넘기는 문맥. 실제 SDK/시계는 factory 를 만드는 쪽(index.ts)이 가지고 있다. */
export interface TransportContext {
  settings: PluginSettings;
  clientId: string;
  getHello(kind: TransportKind): HelloMessage;
  log(level: LogLevel, message: string): void;
  notify(level: 'warn' | 'error', message: string): void;
}
export type TransportFactory = (ctx: TransportContext) => Transport;

export interface BridgeOptions {
  sdk: SdkLike;
  /** 초기(기본) 설정. start() 가 SDK 에서 실제 값을 읽어 덮어쓴다. */
  settings?: PluginSettings;
  transportFactory: TransportFactory;
  clock: Clock;
  log?: (level: LogLevel, message: string) => void;
  pluginName?: string | (() => string);
  pluginVersion?: string;
  /** clientId 생성기(테스트용) */
  randomId?: () => string;
  /** POS key 꼬리(nonce, 영숫자 8자) 생성기(테스트용). 기본은 crypto.getRandomValues. */
  randomNonce?: () => string;
}

export interface BridgeStatus {
  online: boolean;
  transport: TransportKind | null;
  clientId: string;
  queued: number;
  buffered: number;
}

export interface CartWorkView {
  workOrderId: number;
  label: string;
  lines: { title: string; quantity: number; priceValue: number }[];
  total: number;
}

export interface PaymentView {
  at: number;
  type: 'payment.paid' | 'payment.cancelled';
  paymentId: string;
  amount: number | null;
  workOrderIds: number[];
  /** 보냄 / 대기(전송 계층이 아직 못 보냄) */
  sent: boolean;
}

/** [결제] 화면이 그리는 상태. */
export interface BridgeView {
  running: boolean;
  online: boolean;
  /** 서버 welcome 을 받았는지(연결 확인) */
  welcomed: boolean;
  transport: TransportKind | null;
  /** 연결이 안 된 사유(연결됐으면 null) */
  issue: string | null;
  cart: CartWorkView[];
  cartTotal: number;
  activity: ActivityEntry[];
  payments: PaymentView[];
  reconciling: boolean;
}

export interface Bridge {
  start(): Promise<void>;
  /** 상태가 바뀔 때마다 부른다. 해제 함수를 돌려준다. */
  subscribe(listener: () => void): () => void;
  getView(): BridgeView;
  /** 장바구니의 정비 항목으로 결제 대기 기록을 남기고(startPayment 전에) 결제 화면을 연다. */
  openPayment(): Promise<void>;
  /** 최근 주문에서 놓친 결제를 찾는다(수동 버튼). */
  reconcile(): Promise<ReconcileResult>;
  stop(): Promise<void>;
  reloadSettings(): Promise<void>;
  onDraftUpdate(draft: DraftLike): void;
  onPaid(paymentId: string, orderId: string): Promise<void>;
  onCancel(paymentId: string, orderId: string): void;
  markCatalogStale(): void;
  getStatus(): BridgeStatus;
}

// ---------------------------------------------------------------------------
// 오류 판별 유틸
// ---------------------------------------------------------------------------

export function errText(e: unknown): string {
  if (e instanceof Error) return e.message || e.name;
  if (typeof e === 'string') return e;
  if (typeof e === 'object' && e !== null && typeof (e as { message?: unknown }).message === 'string') {
    return (e as { message: string }).message;
  }
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

/**
 * SDK 의 PosPluginSdkRateLimitError 판별.
 * 1) 오류 생성자의 static isPosPluginSdkRateLimitError 가 있으면 그것을 쓴다(실제 SDK).
 * 2) 없으면 name 또는 메시지("...회만 호출할 수 있습니다")로 판별한다.
 */
/**
 * SDK 의 요청 타임아웃 오류("…의 요청이 지연되고 있습니다 - …"). 이미 POS 에 반영됐을 수도 있고 호스트가
 * 아예 응답하지 않는 것일 수도 있으므로 같은 요청을 다른 모양으로 다시 보내는 재시도는 하지 않는다.
 */
export function isTimeoutError(e: unknown): boolean {
  return errText(e).includes('지연');
}

export function isRateLimitError(e: unknown): boolean {
  if (e === null || e === undefined) return false;
  if (typeof e === 'object') {
    const ctor = (e as { constructor?: unknown }).constructor as
      | { isPosPluginSdkRateLimitError?: unknown }
      | undefined;
    if (ctor && typeof ctor.isPosPluginSdkRateLimitError === 'function') {
      try {
        if ((ctor.isPosPluginSdkRateLimitError as (x: unknown) => boolean)(e)) return true;
      } catch {
        // 아래 이름/메시지 판별로 넘어간다
      }
    }
    if ((e as { name?: unknown }).name === 'PosPluginSdkRateLimitError') return true;
  }
  return errText(e).includes(RATE_LIMIT_MESSAGE_PART);
}

function defaultRandomId(): string {
  let hex = '';
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    for (let i = 0; i < bytes.length; i++) hex += bytes[i]!.toString(16).padStart(2, '0');
  } else {
    for (let i = 0; i < 16; i++) hex += Math.floor(Math.random() * 16).toString(16);
  }
  return `pos-${hex}`;
}

const NONCE_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/** 영숫자 8자 nonce. crypto.getRandomValues 를 쓰고, 편향이 없도록 248 이상인 바이트는 버린다. */
export function defaultNonce(): string {
  let out = '';
  while (out.length < POS_NONCE_LENGTH) {
    const bytes = new Uint8Array(16);
    if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
      crypto.getRandomValues(bytes);
    } else {
      for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    }
    for (const b of bytes) {
      if (b >= 248) continue; // 248 = 62 * 4
      out += NONCE_CHARS[b % 62]!;
      if (out.length === POS_NONCE_LENGTH) break;
    }
  }
  return out;
}

/** 장바구니 검증 실패 문구(결제는 시작하지 않는다). */
export const CART_MISMATCH_MESSAGE = 'POS 장바구니가 전산 내용과 맞지 않아요. 결제는 시작하지 않았어요';

// ---------------------------------------------------------------------------
// 내부 타입
// ---------------------------------------------------------------------------

interface ProcessedEntry {
  id: string;
  ok: boolean;
  superseded?: boolean;
  error?: string;
}

interface QueuedCommand {
  id: string;
  kind: string;
  sync: SyncCartPayload | null;
  /** 페이로드 검증 실패 등으로 처리할 수 없는 명령이면 오류 메시지 */
  error: string | null;
}

type StoredPaymentMessage = PaymentPaidMessage | PaymentCancelledMessage;

interface StoredPayment {
  /** 발생 시각(ms, 플러그인 시계) */
  at: number;
  msg: StoredPaymentMessage;
}

/** 결제-작업 연결 기억. */
interface Attrib {
  ids: number[];
  /** draft 가 비어 있게 된 시각. draft 에 라인이 있으면 null. */
  goneAt: number | null;
}

/** runSync / runClear 결과: 성공 토스트 문구 + (ack 뒤에) 결제 화면을 열지 */
interface CommandOutcome {
  message: string;
  startPayment: boolean;
}

function isNumberArray(v: unknown): v is number[] {
  return Array.isArray(v) && v.every((n) => typeof n === 'number');
}

function sameNumbers(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((n, i) => n === b[i]);
}

/** storage 에서 읽은 값이 보존된 결제 메시지 모양이면 돌려준다. */
function parseStoredPayment(v: unknown): StoredPayment | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.at !== 'number' || !Number.isFinite(o.at)) return null;
  const m = o.msg;
  if (typeof m !== 'object' || m === null) return null;
  const msg = m as Record<string, unknown>;
  if (typeof msg.paymentId !== 'string' || typeof msg.orderId !== 'string') return null;
  if (msg.type === 'payment.cancelled') {
    return { at: o.at, msg: { type: 'payment.cancelled', paymentId: msg.paymentId, orderId: msg.orderId } };
  }
  if (
    msg.type === 'payment.paid' &&
    isNumberArray(msg.workOrderIds) &&
    typeof msg.fullyPaid === 'boolean' &&
    typeof msg.paidValue === 'number' &&
    typeof msg.unpaidValue === 'number'
  ) {
    return {
      at: o.at,
      msg: {
        type: 'payment.paid',
        paymentId: msg.paymentId,
        orderId: msg.orderId,
        workOrderIds: [...msg.workOrderIds],
        fullyPaid: msg.fullyPaid,
        paidValue: msg.paidValue,
        unpaidValue: msg.unpaidValue,
      },
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// 구현
// ---------------------------------------------------------------------------

class BridgeImpl implements Bridge {
  private readonly sdk: SdkLike;
  private readonly clock: Clock;
  private readonly sleeper: Sleeper;
  private readonly transportFactory: TransportFactory;
  private readonly logFn: (level: LogLevel, message: string) => void;
  private readonly pluginNameOpt: string | (() => string) | undefined;
  private readonly pluginVersion: string;
  private readonly randomId: () => string;
  private readonly randomNonce: () => string;

  private settings: PluginSettings;
  private clientId = '';
  private transport: Transport | null = null;
  private transportKind: TransportKind | null = null;
  private online = false;
  private started = false;
  /** start() 가 첫 설정 적용까지 끝낸 뒤에만 true. 그 전의 reloadSettings 는 무시한다. */
  private ready = false;
  private stopped = false;
  private warnedEmptyUrl = false;
  private lastAuthToastAt = Number.NEGATIVE_INFINITY;
  private reloadChain: Promise<void> = Promise.resolve();

  // 임시 주문 캐시 (update 이벤트와 변경 메서드 반환값 모두 "마지막에 도착한 것이 최신")
  private draft: DraftLike | null = null;
  private readonly keyMap = new Map<string, string>(); // 우리 key -> POS key
  private readonly keyMapReverse = new Map<string, string>(); // POS key -> 우리 key

  // 명령 큐
  private readonly queue: QueuedCommand[] = [];
  private busy = false;
  private inflightId: string | null = null;
  private processed: ProcessedEntry[] = [];
  private persistChain: Promise<void> = Promise.resolve();

  // 카탈로그 / 카테고리
  private catalog: CatalogItemLike[] | null = null;
  private catalogIndex = new Map<string, CatalogItemLike>();
  private catalogFetchedAt = 0;
  private catalogStale = false;
  /** 판매 중인 상품(밑판 후보) 목록, 원래 순서 */
  private onSale: CatalogItemLike[] = [];

  // 결제 대기 기록 / 처리 내역 / 화면 상태
  private readonly paywatch: PaywatchStore;
  private activity: ActivityEntry[] = [];
  private activityChain: Promise<void> = Promise.resolve();
  private readonly labels = new Map<number, string>();
  private readonly listeners = new Set<() => void>();
  private welcomed = false;
  private welcomedOnce = false;
  private lastIssue: string | null = null;
  private reconciling = false;
  private keymapChain: Promise<void> = Promise.resolve();
  private merchantId = '';

  // draft 보고 / 결제 문맥
  private attrib: Attrib = { ids: [], goneAt: null };
  private lastSentSig = '';
  private lastDraftSentAt = Number.NEGATIVE_INFINITY;
  private draftTimer: unknown = null;
  private readonly handledPayments: string[] = [];
  /** 보낸 결제 메시지(최근 20개, 24시간). 매 welcome 뒤에 다시 보낸다. */
  private payments: StoredPayment[] = [];
  private paymentsChain: Promise<void> = Promise.resolve();

  // 송신 버퍼 / 원격 로그
  private readonly outbox: PluginMessage[] = [];
  private logTimes: number[] = [];

  constructor(options: BridgeOptions) {
    this.sdk = options.sdk;
    this.clock = options.clock;
    this.sleeper = new Sleeper(options.clock);
    this.transportFactory = options.transportFactory;
    this.logFn = options.log ?? (() => {});
    this.pluginNameOpt = options.pluginName;
    this.pluginVersion = options.pluginVersion ?? 'dev';
    this.randomId = options.randomId ?? defaultRandomId;
    this.randomNonce = options.randomNonce ?? defaultNonce;
    this.settings = options.settings ?? normalizeSettings(undefined);
    this.paywatch = new PaywatchStore(options.sdk.storage, options.clock, (m) => this.logLocal('warn', m));
  }

  // ---- 수명 주기 -------------------------------------------------------

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.stopped = false;
    this.ready = false;
    await this.loadClientId();
    await this.loadProcessed();
    await this.loadPayments();
    await this.loadKeymap();
    await this.loadActivity();
    await this.paywatch.load();
    await this.loadMerchantId();
    this.welcomedOnce = false;
    await this.enqueueReload(true);
    if (!this.stopped) this.ready = true;
    this.changed();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.started = false;
    this.ready = false;
    this.sleeper.cancelAll();
    if (this.draftTimer !== null) {
      this.clock.clearTimeout(this.draftTimer);
      this.draftTimer = null;
    }
    await this.stopTransport();
    this.welcomed = false;
    this.changed();
  }

  reloadSettings(): Promise<void> {
    // start() 가 끝나기 전(clientId 등을 읽는 중 포함)에 온 변경 이벤트는 무시한다: start() 가 최신 설정을 읽는다.
    if (!this.ready) return Promise.resolve();
    return this.enqueueReload(false);
  }

  getStatus(): BridgeStatus {
    return {
      online: this.online,
      transport: this.transportKind,
      clientId: this.clientId,
      queued: this.queue.length + (this.inflightId !== null ? 1 : 0),
      buffered: this.outbox.length,
    };
  }

  // ---- 설정 / 전송 계층 --------------------------------------------------

  private enqueueReload(initial: boolean): Promise<void> {
    const run = async (): Promise<void> => {
      const next = await this.readSettings();
      await this.applySettings(next, initial);
    };
    this.reloadChain = this.reloadChain.then(run).catch((e) => {
      this.logLocal('error', `설정 적용 실패: ${errText(e)}`);
    });
    return this.reloadChain;
  }

  private async readSettings(): Promise<PluginSettings> {
    try {
      const values = await this.sdk.setting.getValues<Record<string, SettingValue>>();
      return normalizeSettings(values);
    } catch (e) {
      this.logLocal('error', `설정을 읽지 못했어요: ${errText(e)}`);
      return this.settings;
    }
  }

  private async applySettings(next: PluginSettings, initial: boolean): Promise<void> {
    const prev = this.settings;
    this.settings = next;
    if (this.stopped) return;
    if (!initial && !connectionChanged(prev, next)) return;

    await this.stopTransport();
    if (this.stopped) return;

    if (!next.serverUrl) {
      if (!this.warnedEmptyUrl) {
        this.warnedEmptyUrl = true;
        this.toast('warn', EMPTY_URL_WARNING);
      }
      return;
    }
    this.warnedEmptyUrl = false;
    this.startTransport();
  }

  private startTransport(): void {
    const t = this.transportFactory({
      settings: this.settings,
      clientId: this.clientId,
      getHello: (kind) => this.buildHello(kind),
      log: (level, message) => this.logLocal(level, message),
      notify: (level, message) => this.toast(level, message),
    });
    this.transport = t;
    this.transportKind = t.kind;
    this.online = false;
    t.start({
      onMessage: (msg) => {
        if (this.transport === t) this.onServerMessage(msg);
      },
      onStatus: (status) => {
        if (this.transport === t) this.onTransportStatus(status);
      },
    });
  }

  private async stopTransport(): Promise<void> {
    const t = this.transport;
    this.transport = null;
    this.transportKind = null;
    this.online = false;
    this.welcomed = false;
    if (t) {
      try {
        await t.stop();
      } catch (e) {
        this.logLocal('warn', `전송 계층 종료 중 오류: ${errText(e)}`);
      }
    }
  }

  private onTransportStatus(status: TransportStatus): void {
    const was = this.online;
    this.online = status.online;
    if (!status.online) this.welcomed = false;
    this.lastIssue = status.online ? null : (status.detail ?? this.lastIssue);
    this.transportKind = this.transport ? this.transport.kind : status.kind;
    if (status.online && !was) {
      this.logLocal('info', `결제 연동에 연결됐어요 (${status.kind})`);
      if (this.draft && !this.busy) {
        // 서버가 재시작됐을 수도 있으니 연결될 때마다 현재 POS 장바구니 요약을 한 번 알린다.
        const summary = this.summarize(this.draft);
        this.lastSentSig = summarySignature(summary);
        this.lastDraftSentAt = this.clock.now();
        enqueueOutgoing(this.outbox, { type: 'draft', draft: summary }, OUTBOX_MAX);
      }
      this.flushOutbox();
    } else if (!status.online && was) {
      this.logLocal('warn', '결제 연동 연결이 끊어졌어요');
    }
    this.changed();
  }

  private buildHello(kind: TransportKind): HelloMessage {
    const name =
      typeof this.pluginNameOpt === 'function'
        ? this.pluginNameOpt()
        : (this.pluginNameOpt ?? DEFAULT_PLUGIN_NAME);
    const hello: HelloMessage = {
      type: 'hello',
      clientId: this.clientId,
      pluginName: name || DEFAULT_PLUGIN_NAME,
      pluginVersion: this.pluginVersion,
      transport: kind,
      // 성공(ok:true)으로 끝난 명령만 "이미 처리함"으로 알린다. 실패한 명령은 서버가 다시 보내고,
      // 그러면 저장해 둔 ok:false ack 를 다시 보낸다.
      processedIds: this.processed
        .filter((p) => p.ok)
        .slice(-HELLO_PROCESSED_MAX)
        .map((p) => p.id),
    };
    if (this.merchantId !== '') hello.merchantId = this.merchantId;
    return hello;
  }

  private onServerMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case 'command':
        this.handleCommand(msg.command);
        break;
      case 'welcome':
        this.logLocal('info', `서버 welcome (v${msg.serverVersion})`);
        this.welcomed = true;
        this.lastIssue = null;
        this.resendPayments();
        this.changed();
        // 서버 welcome 을 처음 받은 뒤 1회: 탭이 닫혀 있는 동안 끝난 결제를 찾는다.
        if (!this.welcomedOnce) {
          this.welcomedOnce = true;
          void this.reconcile();
        }
        break;
      case 'error':
        this.logLocal('warn', `서버 오류: ${msg.code} ${msg.message}`);
        if (msg.code === 'UNAUTHORIZED') {
          this.lastIssue = '매장 토큰이 맞지 않아요';
          this.changed();
          const now = this.clock.now();
          if (now - this.lastAuthToastAt >= AUTH_TOAST_INTERVAL_MS) {
            this.lastAuthToastAt = now;
            this.toast(
              'error',
              '매장 토큰이 맞지 않아요. [설정] 탭에서 매장 토큰을 확인해 주세요',
            );
          }
        }
        break;
      default:
        break; // ping 은 전송 계층이 처리한다
    }
  }

  // ---- 키맵 저장(gm.keymap) --------------------------------------------

  private async loadKeymap(): Promise<void> {
    try {
      const raw = await this.sdk.storage.get(KEYMAP_KEY);
      if (typeof raw !== 'string' || raw === '') return;
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return;
      this.keyMap.clear();
      this.keyMapReverse.clear();
      for (const item of (parsed as unknown[]).slice(-KEYMAP_MAX)) {
        if (!Array.isArray(item) || typeof item[0] !== 'string' || typeof item[1] !== 'string') continue;
        this.keyMap.set(item[0], item[1]);
        this.keyMapReverse.set(item[1], item[0]);
      }
    } catch (e) {
      this.logLocal('warn', `키 연결 기록을 읽지 못했어요: ${errText(e)}`);
    }
  }

  private persistKeymap(): void {
    // 오래된 것부터 KEYMAP_MAX 개를 넘으면 버린다.
    while (this.keyMap.size > KEYMAP_MAX) {
      const oldest = this.keyMap.keys().next().value as string;
      this.dropMapping(oldest);
    }
    this.keymapChain = this.keymapChain
      .then(() => this.sdk.storage.set(KEYMAP_KEY, JSON.stringify([...this.keyMap.entries()])))
      .catch((e) => {
        this.logLocal('warn', `키 연결 기록을 저장하지 못했어요: ${errText(e)}`);
      });
  }

  /** 장바구니에 더는 없는 POS key 의 연결을 정리한다(명령 처리 중에는 호출하지 않는다). */
  private pruneKeymap(d: DraftLike): void {
    if (this.keyMap.size === 0) return;
    const present = new Set(d.lineItems.map((l) => l.key));
    let changed = false;
    for (const [ourKey, posKey] of [...this.keyMap.entries()]) {
      if (!present.has(posKey)) {
        this.dropMapping(ourKey);
        changed = true;
      }
    }
    if (changed) this.persistKeymap();
  }

  // ---- merchantId (hello 의 선택 필드) -------------------------------------

  private async loadMerchantId(): Promise<void> {
    try {
      const v = await this.sdk.storage.get(MERCHANT_ID_KEY);
      if (typeof v === 'string' && v !== '') {
        this.merchantId = v;
        return;
      }
    } catch (e) {
      this.logLocal('warn', `merchantId 를 읽지 못했어요: ${errText(e)}`);
    }
    try {
      const m = await this.sdk.merchant.getMerchant(); // 호출 제한 대상: 캐시가 없을 때만 부른다
      if (m && typeof m.id === 'number' && Number.isFinite(m.id)) {
        this.merchantId = String(m.id);
        await this.sdk.storage.set(MERCHANT_ID_KEY, this.merchantId);
      }
    } catch (e) {
      this.logLocal('warn', `merchantId 를 가져오지 못했어요(없이 진행): ${errText(e)}`);
    }
  }

  // ---- 처리 내역 / 화면 상태 -------------------------------------------------

  private async loadActivity(): Promise<void> {
    try {
      this.activity = parseActivity(await this.sdk.storage.get(ACTIVITY_KEY));
    } catch (e) {
      this.logLocal('warn', `처리 내역을 읽지 못했어요: ${errText(e)}`);
    }
  }

  private recordActivity(label: string, result: ActivityResult, detail?: string): void {
    const entry: ActivityEntry = { at: new Date(this.clock.now()).toISOString(), label, result };
    if (detail !== undefined) entry.detail = detail.slice(0, 200);
    this.activity = addActivity(this.activity, entry);
    this.activityChain = this.activityChain
      .then(() => this.sdk.storage.set(ACTIVITY_KEY, JSON.stringify(this.activity)))
      .catch((e) => {
        this.logLocal('warn', `처리 내역을 저장하지 못했어요: ${errText(e)}`);
      });
    this.changed();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private changed(): void {
    for (const l of [...this.listeners]) {
      try {
        l();
      } catch (e) {
        this.logLocal('warn', `화면 갱신 중 오류: ${errText(e)}`);
      }
    }
  }

  getView(): BridgeView {
    const cartMap = new Map<number, CartWorkView>();
    if (this.draft) {
      for (const li of this.draft.lineItems) {
        const ourKey = this.ourKeyOf(li.key);
        if (!isOurKey(ourKey)) continue;
        const id = parseWorkOrderId(ourKey);
        if (id === null) continue;
        let w = cartMap.get(id);
        if (!w) {
          w = { workOrderId: id, label: this.labels.get(id) ?? '', lines: [], total: 0 };
          cartMap.set(id, w);
        }
        w.lines.push({ title: li.item.title, quantity: li.quantity, priceValue: li.itemPrice.priceValue });
        w.total += li.itemPrice.priceValue * li.quantity;
      }
    }
    const cart = [...cartMap.values()];
    const waiting = new Set<string>();
    for (const m of this.outbox) {
      if (m.type === 'payment.paid' || m.type === 'payment.cancelled') waiting.add(`${m.type}:${m.paymentId}`);
    }
    const noUrl = this.settings.serverUrl === '';
    let issue: string | null = null;
    if (!this.started) issue = noUrl ? '매장 토큰이 설정되지 않았어요' : '연결을 시작하지 않았어요';
    else if (!this.online) issue = this.lastIssue ?? (noUrl ? '매장 토큰이 설정되지 않았어요' : '연결을 기다리고 있어요');
    return {
      running: this.started && !this.stopped,
      online: this.online,
      welcomed: this.welcomed,
      transport: this.transportKind,
      issue,
      cart,
      cartTotal: cart.reduce((sum, w) => sum + w.total, 0),
      activity: [...this.activity],
      payments: this.payments
        .map((p) => ({
          at: p.at,
          type: p.msg.type,
          paymentId: p.msg.paymentId,
          amount: p.msg.type === 'payment.paid' ? p.msg.paidValue : null,
          workOrderIds: p.msg.type === 'payment.paid' ? [...p.msg.workOrderIds] : [],
          sent: !waiting.has(`${p.msg.type}:${p.msg.paymentId}`),
        }))
        .reverse(),
      reconciling: this.reconciling,
    };
  }

  // ---- 결제 화면 열기 / 놓친 결제 찾기 ---------------------------------------

  async openPayment(): Promise<void> {
    await this.ensureDraft();
    const d = this.current;
    const keys: string[] = [];
    const ids = new Set<number>();
    for (const li of d.lineItems) {
      const ourKey = this.ourKeyOf(li.key);
      if (!isOurKey(ourKey)) continue;
      keys.push(ourKey);
      const id = parseWorkOrderId(ourKey);
      if (id !== null) ids.add(id);
    }
    if (ids.size > 0) {
      // startPayment 전에 저장한다(결제 화면으로 넘어가면 탭이 닫힐 수 있다).
      await this.paywatch.add({ workOrderIds: [...ids].sort((a, b) => a - b), keys, total: d.price.orderPriceValue });
    }
    await this.sdk.draftOrder.startPayment();
  }

  async reconcile(): Promise<ReconcileResult> {
    if (this.reconciling) return { ran: false, paid: 0, cancelled: 0 };
    this.reconciling = true;
    this.changed();
    try {
      return await reconcilePayments({
        paywatch: () => this.paywatch.entries(),
        isRateLimit: isRateLimitError,
        getOrders: (params) => this.sdk.order.getOrders(params),
        sleep: (ms) => this.sleeper.sleep(ms),
        now: () => this.clock.now(),
        alreadySentPaid: (id) =>
          this.handledPayments.includes(id) ||
          this.payments.some((p) => p.msg.type === 'payment.paid' && p.msg.paymentId === id),
        alreadySentCancelled: (id) =>
          this.payments.some((p) => p.msg.type === 'payment.cancelled' && p.msg.paymentId === id),
        send: (msg) => {
          if (msg.type === 'payment.paid') this.handledPayments.push(msg.paymentId);
          this.sendPayment(msg);
        },
        clearPaywatch: (ids) => this.paywatch.removeFor(ids),
        log: (level, message) => this.logLocal(level, message),
        isStopped: () => this.stopped,
      });
    } catch (e) {
      this.logLocal('warn', `놓친 결제 찾기 실패: ${errText(e)}`);
      return { ran: true, paid: 0, cancelled: 0, error: errText(e) };
    } finally {
      this.reconciling = false;
      this.changed();
    }
  }

  // ---- clientId / 처리 이력 저장 ----------------------------------------

  private async loadClientId(): Promise<void> {
    try {
      const v = await this.sdk.storage.get(CLIENT_ID_KEY);
      if (typeof v === 'string' && v.length >= 8) {
        this.clientId = v;
        return;
      }
    } catch (e) {
      this.logLocal('warn', `clientId 를 읽지 못했어요: ${errText(e)}`);
    }
    this.clientId = this.randomId();
    try {
      await this.sdk.storage.set(CLIENT_ID_KEY, this.clientId);
    } catch (e) {
      this.logLocal('warn', `clientId 를 저장하지 못했어요: ${errText(e)}`);
    }
  }

  private async loadProcessed(): Promise<void> {
    try {
      const raw = await this.sdk.storage.get(PROCESSED_KEY);
      if (typeof raw !== 'string' || raw === '') return;
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return;
      const out: ProcessedEntry[] = [];
      for (const item of parsed as unknown[]) {
        if (typeof item === 'string') {
          out.push({ id: item, ok: true });
        } else if (typeof item === 'object' && item !== null) {
          const o = item as Record<string, unknown>;
          if (typeof o.id !== 'string') continue;
          const entry: ProcessedEntry = { id: o.id, ok: o.ok !== false };
          if (o.superseded === true) entry.superseded = true;
          if (typeof o.error === 'string') entry.error = o.error;
          out.push(entry);
        }
      }
      this.processed = out.slice(-PROCESSED_MAX);
    } catch (e) {
      this.logLocal('warn', `처리 이력을 읽지 못했어요: ${errText(e)}`);
    }
  }

  private recordProcessed(entry: ProcessedEntry): void {
    this.processed = this.processed.filter((p) => p.id !== entry.id);
    this.processed.push(entry);
    if (this.processed.length > PROCESSED_MAX) {
      this.processed = this.processed.slice(-PROCESSED_MAX);
    }
    // 저장 순서가 뒤집히지 않도록 직렬화하고, 실행 시점의 최신 상태를 저장한다.
    this.persistChain = this.persistChain
      .then(() => this.sdk.storage.set(PROCESSED_KEY, JSON.stringify(this.processed)))
      .catch((e) => {
        this.logLocal('warn', `처리 이력을 저장하지 못했어요: ${errText(e)}`);
      });
  }

  // ---- 결제 메시지 보존 ------------------------------------------

  private async loadPayments(): Promise<void> {
    try {
      const raw = await this.sdk.storage.get(PAYMENTS_KEY);
      if (typeof raw !== 'string' || raw === '') return;
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return;
      const now = this.clock.now();
      const out: StoredPayment[] = [];
      for (const item of parsed as unknown[]) {
        const p = parseStoredPayment(item);
        if (p && now - p.at <= PAYMENTS_MAX_AGE_MS) out.push(p);
      }
      this.payments = out.slice(-PAYMENTS_MAX);
      // 이미 보고한 결제는 플러그인을 다시 시작한 뒤에 같은 paid 이벤트가 와도 getOrder 를 다시 부르지 않는다.
      for (const p of this.payments) {
        if (p.msg.type === 'payment.paid' && !this.handledPayments.includes(p.msg.paymentId)) {
          this.handledPayments.push(p.msg.paymentId);
        }
      }
    } catch (e) {
      this.logLocal('warn', `결제 보존 기록을 읽지 못했어요: ${errText(e)}`);
    }
  }

  private prunePayments(): void {
    const now = this.clock.now();
    this.payments = this.payments.filter((p) => now - p.at <= PAYMENTS_MAX_AGE_MS).slice(-PAYMENTS_MAX);
  }

  private persistPayments(): void {
    this.paymentsChain = this.paymentsChain
      .then(() => this.sdk.storage.set(PAYMENTS_KEY, JSON.stringify(this.payments)))
      .catch((e) => {
        this.logLocal('warn', `결제 보존 기록을 저장하지 못했어요: ${errText(e)}`);
      });
  }

  /** 결제 메시지를 보존하고(최근 20개 / 24시간) 지금 보낸다. 서버는 paymentId 로 중복을 걸러낸다. */
  private sendPayment(msg: StoredPaymentMessage): void {
    this.payments = this.payments.filter((p) => !(p.msg.type === msg.type && p.msg.paymentId === msg.paymentId));
    this.payments.push({ at: this.clock.now(), msg });
    this.prunePayments();
    this.persistPayments();
    this.emit(msg);
    this.changed();
  }

  /** welcome 을 받을 때마다 보존된 결제 메시지를 전부 다시 보낸다(서버가 재시작/ack 유실을 겪었을 수 있다). */
  private resendPayments(): void {
    if (this.payments.length === 0) return;
    const before = this.payments.length;
    this.prunePayments();
    if (this.payments.length !== before) this.persistPayments();
    for (const p of [...this.payments]) this.emit(p.msg);
  }

  // ---- 송신 ------------------------------------------------------------

  private emit(msg: PluginMessage): void {
    const t = this.transport;
    if (t && this.online) {
      let sent = false;
      try {
        sent = t.send(msg);
      } catch (e) {
        this.logLocal('warn', `전송 실패: ${errText(e)}`);
      }
      if (sent) return;
    }
    enqueueOutgoing(this.outbox, msg, OUTBOX_MAX);
  }

  private flushOutbox(): void {
    const t = this.transport;
    if (!t || !this.online || this.outbox.length === 0) return;
    const pending = this.outbox.splice(0, this.outbox.length);
    // ack / payment.* 를 먼저 보낸다.
    const ordered = [
      ...pending.filter((m) => isPriorityMessage(m)),
      ...pending.filter((m) => !isPriorityMessage(m)),
    ];
    for (let i = 0; i < ordered.length; i++) {
      let sent = false;
      try {
        sent = t.send(ordered[i]!);
      } catch (e) {
        this.logLocal('warn', `전송 실패: ${errText(e)}`);
      }
      if (!sent) {
        for (const m of ordered.slice(i)) enqueueOutgoing(this.outbox, m, OUTBOX_MAX);
        return;
      }
    }
  }

  // ---- 로그 / 토스트 -----------------------------------------------------

  private logLocal(level: LogLevel, message: string): void {
    try {
      this.logFn(level, message);
    } catch {
      // 로깅 실패는 무시
    }
  }

  /** 로컬 로그 + (warn/error 는) 서버로 log 메시지 전송. 분당 최대 5개. */
  private report(level: LogLevel, message: string): void {
    this.logLocal(level, message);
    if (level === 'info') return;
    const now = this.clock.now();
    this.logTimes = this.logTimes.filter((t) => now - t < 60_000);
    if (this.logTimes.length >= LOG_MAX_PER_MINUTE) return;
    this.logTimes.push(now);
    this.emit({ type: 'log', level, message });
  }

  private toast(kind: 'success' | 'warn' | 'error', message: string): void {
    try {
      this.sdk.toast[kind]({ message });
    } catch (e) {
      this.logLocal('warn', `토스트 표시 실패: ${errText(e)}`);
    }
  }

  /** 명령 처리 결과 알림: "알림 표시" 설정을 따른다. */
  private toastResult(kind: 'success' | 'error', message: string): void {
    if (this.settings.showToast) this.toast(kind, message);
  }

  // ---- 명령 수신 / 큐 ----------------------------------------------------

  private handleCommand(raw: Command): void {
    const id = raw.id;
    const done = this.processed.find((p) => p.id === id);
    if (done) {
      // 이미 처리한 명령: 다시 처리하지 않고 저장해 둔 ack 를 다시 보낸다.
      this.emitAck(done);
      return;
    }
    if (this.inflightId === id || this.queue.some((q) => q.id === id)) return; // 재전송된 중복

    const q: QueuedCommand = { id, kind: String(raw.kind), sync: null, error: null };
    if (raw.kind === 'SYNC_CART') {
      const r = parseSyncCartPayload(raw.payload);
      if (r.ok) q.sync = r.value;
      else q.error = r.error;
    } else if (raw.kind === 'CLEAR_CART') {
      const r = parseClearCartPayload(raw.payload);
      if (!r.ok) q.error = r.error;
    } else {
      q.error = `지원하지 않는 명령: ${String(raw.kind)}`;
    }
    this.queue.push(q);
    this.kick();
  }

  private kick(): void {
    if (this.busy || this.stopped) return;
    this.busy = true;
    void this.runLoop();
  }

  private async runLoop(): Promise<void> {
    try {
      // 같은 틱에 연달아 들어온 명령들이 큐에 모이도록 한 번 양보한다.
      await Promise.resolve();
      while (!this.stopped && this.queue.length > 0) {
        const q = this.queue.shift()!;
        this.inflightId = q.id;
        try {
          await this.processOne(q);
        } catch (e) {
          this.report('error', `명령 처리 중 예기치 않은 오류: ${errText(e)}`);
        } finally {
          this.inflightId = null;
        }
      }
    } finally {
      this.busy = false;
      if (!this.stopped) {
        if (this.queue.length > 0) this.kick();
        else this.scheduleDraftReport(); // 처리 중 사용자가 바꾼 내용 보고
      }
    }
  }

  private findLaterSync(q: QueuedCommand): QueuedCommand | null {
    if (q.kind !== 'SYNC_CART' || !q.sync) return null;
    for (const other of this.queue) {
      if (other.kind === 'SYNC_CART' && other.sync && other.sync.workOrderId === q.sync.workOrderId) {
        return other;
      }
    }
    return null;
  }

  private async processOne(q: QueuedCommand): Promise<void> {
    // 같은 작업의 더 최신 SYNC_CART 가 큐에 있으면 이것은 건너뛴다(결제 시작 요청은 최신 것에 합친다).
    const later = this.findLaterSync(q);
    if (later && later.sync && q.sync) {
      if (q.sync.startPayment) later.sync.startPayment = true;
      this.finish(q, { ok: true, superseded: true });
      this.recordActivity(this.labelOf(q.sync), 'skipped', '더 최신 요청이 있어요');
      return;
    }
    if (q.error !== null) {
      this.failCommand(q, q.error);
      return;
    }

    let retries = 0;
    for (;;) {
      if (this.stopped) return;
      try {
        const outcome = q.kind === 'SYNC_CART' ? await this.runSync(q.sync!) : await this.runClear();
        this.noteCommandResult();
        // 결제 화면을 열기 전에(탭이 닫힐 수 있다) 결제 대기 기록을 남긴다.
        if (q.sync && q.sync.lines.length > 0) {
          await this.paywatch.add({
            workOrderIds: [q.sync.workOrderId],
            keys: q.sync.lines.map((l) => l.key),
            total: q.sync.lines.reduce((sum, l) => sum + l.unitPrice * l.quantity, 0),
          });
        }
        this.finish(q, { ok: true });
        this.recordActivity(
          q.sync ? this.labelOf(q.sync) : '',
          outcome.startPayment ? 'paying' : q.sync && q.sync.lines.length > 0 ? 'added' : 'cleared',
        );
        this.toastResult('success', outcome.message);
        if (outcome.startPayment) {
          // 결제 화면이 열리면 탭이 다시 로드될 수 있다. 처리 이력(finish 가 걸어 둔 저장)이 storage 에 들어간 뒤에 열어야,
          // 다시 로드된 뒤 서버가 같은 명령을 재전송해도 또 담고 결제 화면을 또 여는 일(이중 결제 위험)이 없다.
          await this.persistChain;
          // 결제 화면 자체는 ack 를 보낸 뒤에 기다리지 않고 연다: 호스트가 응답하지 않아도 큐/ack 가 멈추지 않는다.
          this.startPaymentAsync();
        }
        return;
      } catch (e) {
        if (this.stopped) return;
        this.noteCommandResult(); // 일부만 적용된 상태일 수 있다
        if (isRateLimitError(e) && retries < RATE_LIMIT_MAX_RETRIES) {
          retries++;
          this.logLocal(
            'warn',
            `POS 호출 제한에 걸렸어요. ${RATE_LIMIT_WAIT_MS / 1000}초 후 다시 시도해요 (${retries}/${RATE_LIMIT_MAX_RETRIES})`,
          );
          await this.sleeper.sleep(RATE_LIMIT_WAIT_MS);
          continue;
        }
        this.failCommand(q, errText(e));
        return;
      }
    }
  }

  /**
   * draftOrder.startPayment() 를 기다리지 않고 부른다. 토스 에뮬레이터처럼 이 요청에 응답하지 않는 호스트에서는
   * SDK 가 30초 뒤 타임아웃 오류를 던지는데, 그동안 명령 큐와 ack 를 막지 않는다. 실패/타임아웃은 로그만 남긴다.
   */
  private startPaymentAsync(): void {
    let pending: Promise<void>;
    try {
      pending = Promise.resolve(this.sdk.draftOrder.startPayment());
    } catch (e) {
      this.onStartPaymentFailed(e);
      return;
    }
    pending.catch((e: unknown) => this.onStartPaymentFailed(e));
  }

  private onStartPaymentFailed(e: unknown): void {
    if (this.stopped) return;
    if (isTimeoutError(e)) {
      // 응답이 없는 것일 뿐 결제 화면은 열렸을 수 있다.
      this.logLocal('warn', `결제 화면 요청에 응답이 없어요(화면은 열렸을 수 있어요): ${errText(e)}`);
    } else {
      this.report('warn', `결제 화면을 열지 못했어요: ${errText(e)}`);
    }
  }

  private failCommand(q: QueuedCommand, message: string): void {
    this.finish(q, { ok: false, error: message });
    this.recordActivity(q.sync ? this.labelOf(q.sync) : '', 'failed', message);
    const who = q.sync ? this.labelOf(q.sync) : '정비소 전산 명령';
    this.toastResult('error', `${who} 처리에 실패했어요: ${message}`);
    this.report('error', `명령 ${q.id}(${q.kind}) 실패: ${message}`);
  }

  private finish(
    q: QueuedCommand,
    result: { ok: boolean; superseded?: boolean; error?: string },
  ): void {
    const entry: ProcessedEntry = { id: q.id, ok: result.ok };
    if (result.superseded) entry.superseded = true;
    if (result.error !== undefined) entry.error = result.error.slice(0, 300);
    this.recordProcessed(entry);
    this.emitAck(entry);
  }

  private emitAck(entry: ProcessedEntry): void {
    const summary = this.draft ? this.summarize(this.draft) : null;
    const ack: AckMessage = { type: 'ack', commandId: entry.id, ok: entry.ok, draft: summary };
    if (entry.superseded) ack.superseded = true;
    if (entry.error !== undefined) ack.error = entry.error;
    if (summary) {
      // ack 에 실린 draft 는 이미 보고한 것으로 본다(중복 draft 메시지 방지).
      this.lastSentSig = summarySignature(summary);
      this.lastDraftSentAt = this.clock.now();
    }
    this.emit(ack);
  }

  private labelOf(p: SyncCartPayload): string {
    return p.label !== '' ? p.label : `작업 #${p.workOrderId}`;
  }

  // ---- 장바구니 조정 -----------------------------------------------------
  //
  // key 규칙: 정비 전산이 준 논리 key(gm-{작업ID}-{라인ID}) 와 POS 에 담는 key 는 다르다.
  //  - POS key = 논리 key + `_` + nonce(8자). 라인을 담을 때마다 새로 발급한다(옛 라인과 key 가 겹치지 않게).
  //  - 프로토콜·보고·paywatch 에는 항상 논리 key 를 쓴다.
  //  - POS 가 key 를 바꿔 버린 경우만 keyMap(논리 -> POS)에 기억한다.
  // 명령(SYNC_CART/CLEAR_CART)은 캐시한 draft 를 믿지 않고 시작할 때와 끝날 때 draftOrder.get() 으로 실제 상태를 읽는다.

  private get current(): DraftLike {
    if (!this.draft) throw new Error('임시 주문 상태를 알 수 없어요');
    return this.draft;
  }

  /** POS key -> 논리 key. 우리 라인이 아니면 null. keyMap(POS 가 바꾼 key)을 먼저 본다. */
  private logicalOf(posKey: string): string | null {
    const mapped = this.keyMapReverse.get(posKey);
    if (mapped !== undefined) return mapped;
    return logicalKeyOf(posKey);
  }

  /** 보고/표시용: 논리 key. 우리 key 가 아니면 POS key 그대로(isOurKey 가 false). */
  private ourKeyOf(posKey: string): string {
    return this.logicalOf(posKey) ?? posKey;
  }

  private setMapping(ourKey: string, posKey: string): void {
    this.dropMapping(ourKey);
    this.keyMap.set(ourKey, posKey);
    this.keyMapReverse.set(posKey, ourKey);
    this.persistKeymap();
  }

  private dropMapping(ourKey: string): void {
    const posKey = this.keyMap.get(ourKey);
    if (posKey !== undefined) {
      this.keyMap.delete(ourKey);
      this.keyMapReverse.delete(posKey);
      if (this.keyMap.size < KEYMAP_MAX) this.persistKeymap();
    }
  }

  private summarize(d: DraftLike): DraftSummary {
    return summarizeDraft(d, this.keyMapReverse, new Date(this.clock.now()).toISOString());
  }

  private async ensureDraft(): Promise<void> {
    if (!this.draft) this.draft = await this.sdk.draftOrder.get();
  }

  /** 실제 POS 상태를 새로 읽고 캐시(보고/이벤트용)도 갱신한다. 명령 처리의 판단은 항상 이 값으로 한다. */
  private async readDraft(): Promise<DraftLike> {
    const d = await this.sdk.draftOrder.get();
    this.draft = d;
    return d;
  }

  /**
   * draft 를 바꾸는 SDK 호출. 실패하면(타임아웃이면 POS 에 반영됐는지 알 수 없다) 캐시한 draft 를 버려서
   * 다음 명령이 draftOrder.get() 으로 실제 상태를 한 번 다시 읽게 한다.
   */
  private async mutate<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      this.draft = null;
      throw e;
    }
  }

  /** draft 의 우리 라인을 논리 key 별로 묶는다(POS 순서 유지). */
  private groupOurLines(d: DraftLike): Map<string, DraftLineItemLike[]> {
    const groups = new Map<string, DraftLineItemLike[]>();
    for (const li of d.lineItems) {
      const logical = this.logicalOf(li.key);
      if (logical === null) continue;
      const g = groups.get(logical);
      if (g) g.push(li);
      else groups.set(logical, [li]);
    }
    return groups;
  }

  /** 이 SYNC_CART 가 건드릴 수 있는 논리 key 인지(exclusive 이면 우리 라인 전부, 아니면 이 작업의 것만). */
  private inSyncScope(logical: string, p: SyncCartPayload): boolean {
    return p.exclusive || logical.startsWith(`${OUR_KEY_PREFIX}${p.workOrderId}-`);
  }

  private async runSync(p: SyncCartPayload): Promise<CommandOutcome> {
    if (p.label !== '') this.labels.set(p.workOrderId, p.label);

    // 1~4) 새로 읽은 draft 로 맞춘다. 5) 다시 읽어 검증하고, 틀리면 한 번 더 맞춘 뒤 다시 검증한다.
    await this.syncOnce(p, await this.readDraft());
    let check = await this.verifySync(p);
    if (!check.ok) {
      this.logLocal('warn', `POS 장바구니 검증에 실패해 한 번 더 맞춰요: ${check.reason}`);
      await this.syncOnce(p, check.draft);
      check = await this.verifySync(p);
    }
    if (!check.ok) {
      this.logLocal('error', `POS 장바구니 검증 실패: ${check.reason}`);
      throw new Error(CART_MISMATCH_MESSAGE);
    }

    // 결제 화면: 여기서는 열지 않고, 호출 여부만 알린다(ack 를 보낸 뒤 비동기로 연다). 검증을 통과한 경우에만 true.
    const desired = p.lines;
    const startPayment = p.startPayment && this.settings.allowStartPayment && desired.length > 0;

    const label = this.labelOf(p);
    if (startPayment) return { message: `${label} 결제를 시작해요`, startPayment };
    if (desired.length > 0) return { message: `${label} 상품 ${desired.length}건을 담았어요`, startPayment };
    return { message: `${label} 상품을 POS에서 뺐어요`, startPayment };
  }

  /**
   * 주어진(방금 읽은) draft 를 원하는 목록에 맞춘다. POS 에서 직접 담은(gm- 아닌) 라인은 건드리지 않는다.
   *  - 원하는 목록에 없는 묶음: exclusive 면 우리 라인 전부, 아니면 이 작업(`gm-{작업ID}-`)의 라인만 지운다.
   *  - 원하는 key 인데 라인이 2개 이상이거나 단가/수량이 다르면 전부 지우고 새로 담는다(updateItemQuantity 는 쓰지 않는다).
   */
  private async syncOnce(p: SyncCartPayload, d: DraftLike): Promise<void> {
    const wanted = new Map(p.lines.map((l) => [l.key, l] as const));
    const kept = new Set<string>();
    const doomed: DraftLineItemLike[] = [];
    for (const [logical, lines] of this.groupOurLines(d)) {
      const line = wanted.get(logical);
      if (!line) {
        if (this.inSyncScope(logical, p)) doomed.push(...lines);
        continue;
      }
      const only = lines.length === 1 ? lines[0]! : null;
      if (only && only.itemPrice.priceValue === line.unitPrice && only.quantity === line.quantity) {
        kept.add(logical);
      } else {
        doomed.push(...lines);
      }
    }
    await this.deleteLines(doomed);
    for (const line of p.lines) {
      if (!kept.has(line.key)) await this.addLine(line, p);
    }
  }

  /** 지금 POS 가 원하는 목록과 정확히 같은지 get() 으로 확인한다. */
  private async verifySync(p: SyncCartPayload): Promise<{ ok: boolean; reason: string; draft: DraftLike }> {
    const d = await this.readDraft();
    const groups = this.groupOurLines(d);
    const wanted = new Map(p.lines.map((l) => [l.key, l] as const));
    for (const line of p.lines) {
      const lines = groups.get(line.key) ?? [];
      if (lines.length !== 1) return { ok: false, reason: `${line.key} 라인 ${lines.length}개`, draft: d };
      const li = lines[0]!;
      if (li.quantity !== line.quantity || li.itemPrice.priceValue !== line.unitPrice) {
        return {
          ok: false,
          reason: `${line.key} 수량/단가 불일치 (POS ${li.quantity}x${li.itemPrice.priceValue}, 전산 ${line.quantity}x${line.unitPrice})`,
          draft: d,
        };
      }
    }
    for (const logical of groups.keys()) {
      if (!wanted.has(logical) && this.inSyncScope(logical, p)) {
        return { ok: false, reason: `원하지 않는 라인이 남아 있어요 (${logical})`, draft: d };
      }
    }
    return { ok: true, reason: '', draft: d };
  }

  private async runClear(): Promise<CommandOutcome> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const d = await this.readDraft();
      const ours = d.lineItems.filter((l) => this.logicalOf(l.key) !== null);
      if (ours.length === 0) return { message: '정비소 전산 항목을 POS에서 비웠어요', startPayment: false };
      await this.deleteLines(ours);
    }
    const d = await this.readDraft();
    if (d.lineItems.some((l) => this.logicalOf(l.key) !== null)) {
      throw new Error('POS 장바구니의 전산 항목을 모두 지우지 못했어요');
    }
    return { message: '정비소 전산 항목을 POS에서 비웠어요', startPayment: false };
  }

  /** 라인들을 POS key 별로 묶어 지운다(같은 POS key 가 여러 줄이면 그 수만큼). */
  private async deleteLines(lines: readonly DraftLineItemLike[]): Promise<void> {
    const counts = new Map<string, number>();
    for (const l of lines) counts.set(l.key, (counts.get(l.key) ?? 0) + 1);
    for (const [posKey, n] of counts) await this.deleteLine(posKey, n);
  }

  /**
   * deleteLineItem(posKey). 옛 중복(같은 posKey 여러 줄)은 지운 뒤 돌려받은 draft 에 같은 posKey 가 남아 있으면 다시 지운다
   * (최대 줄 수 + 1 회). "없다"는 오류가 나면 get() 으로 실제로 없어졌는지 확인하고 넘어간다.
   */
  private async deleteLine(posKey: string, count: number): Promise<void> {
    const present = (): boolean => this.draft === null || this.draft.lineItems.some((l) => l.key === posKey);
    for (let i = 0; i <= count && present(); i++) {
      try {
        this.draft = await this.mutate(() => this.sdk.draftOrder.deleteLineItem(posKey));
      } catch (e) {
        if (isRateLimitError(e) || isTimeoutError(e)) throw e;
        const fresh = await this.readDraft();
        if (fresh.lineItems.some((l) => l.key === posKey)) throw e; // 실제로 남아 있으면 진짜 실패
      }
    }
    const logical = this.keyMapReverse.get(posKey);
    if (logical !== undefined) this.dropMapping(logical);
  }

  /** 라인 하나를 새 POS key(논리 key + _nonce)로 담고, POS 에 실제로 들어갔는지 확인한다. */
  private async addLine(line: CartLine, p: SyncCartPayload): Promise<void> {
    const memo = makeLineMemo(p.workOrderId, p.label);
    const { primary, fallback } = await this.pickBases(line.productCode);
    const posKey = makePosKey(line.key, this.randomNonce());
    const before = new Set((this.draft?.lineItems ?? []).map((l) => l.key));
    const result = await this.addWithFallback({ ...line, key: posKey }, memo, primary, fallback);
    this.draft = result;
    if (result.lineItems.some((l) => l.key === posKey)) return;

    // 돌려받은 draft 가 POS 반영보다 늦을 수 있다: 실제 상태를 한 번 더 읽는다.
    const fresh = await this.readDraft();
    if (fresh.lineItems.some((l) => l.key === posKey)) return;

    // POS 가 key 를 바꿨다: 추가 전에 없던 새 라인 중 title 과 단가가 같은 것을 keyMap 으로 기억한다.
    const picked = fresh.lineItems.find(
      (l) =>
        !before.has(l.key) &&
        this.logicalOf(l.key) === null &&
        l.item.title === line.title &&
        l.itemPrice.priceValue === line.unitPrice,
    );
    if (!picked) throw new Error(`POS 가 추가한 항목을 확인하지 못했어요 (${line.key})`);
    this.setMapping(line.key, picked.key);
    this.logLocal('warn', `POS 가 key 를 바꿨어요: ${posKey} -> ${picked.key}`);
  }

  /** 호출 제한/타임아웃이 아닌 오류만 "다른 밑판으로 다시 시도"할 가치가 있다. */
  private canRetryAdd(e: unknown): boolean {
    return !isRateLimitError(e) && !isTimeoutError(e);
  }

  /**
   * addLineItem 과 재시도(한 번뿐, 호출 제한/타임아웃 오류는 재시도하지 않는다):
   * 상품코드로 찾은 밑판으로 추가하다 실패하면 [기본 상품 코드]/첫 판매 상품 밑판으로 한 번 다시 시도한다.
   */
  private async addWithFallback(
    line: CartLine,
    memo: string,
    primary: CatalogItemLike,
    fallback: CatalogItemLike | null,
  ): Promise<DraftLike> {
    try {
      return await this.mutate(() => this.sdk.draftOrder.addLineItem(buildLineItemDto(primary, line, memo)));
    } catch (e) {
      if (!fallback || !this.canRetryAdd(e)) throw e;
      this.logLocal(
        'warn',
        `POS 상품(${primary.id})으로 추가하지 못해 기본 상품(${fallback.id}) 밑판으로 다시 시도해요: ${errText(e)}`,
      );
      return await this.mutate(() => this.sdk.draftOrder.addLineItem(buildLineItemDto(fallback, line, memo)));
    }
  }

  // ---- 카탈로그 매칭 -----------------------------------------------------

  markCatalogStale(): void {
    this.catalogStale = true;
  }

  private async ensureCatalog(): Promise<void> {
    const now = this.clock.now();
    const need =
      this.catalog === null || (this.catalogStale && now - this.catalogFetchedAt >= CATALOG_REFRESH_MS);
    if (!need) return;
    try {
      const items = await this.sdk.catalog.getCatalogs();
      this.catalog = Array.isArray(items) ? items : [];
      this.catalogStale = false;
      this.catalogFetchedAt = this.clock.now();
      this.rebuildCatalogIndex();
    } catch (e) {
      if (isRateLimitError(e)) throw e; // 명령 단위로 15초 후 재시도
      // 밑판이 꼭 필요하므로, 이전에 받아 둔 목록이 없으면 이 명령은 실패시킨다.
      if (this.catalog === null) throw e;
      this.logLocal('warn', `POS 상품 목록을 다시 가져오지 못했어요(이전 목록으로 진행): ${errText(e)}`);
      this.catalogStale = true;
      this.catalogFetchedAt = now; // 5분 뒤에 다시 시도
    }
  }

  private rebuildCatalogIndex(): void {
    this.catalogIndex = new Map();
    this.onSale = [];
    for (const item of this.catalog ?? []) {
      // 판매 중(ON_SALE)인 상품만 밑판으로 쓴다: 품절/판매불가/삭제된 상품에 담으면 POS 가 거절하거나 혼란스러워진다.
      if (item.state !== 'ON_SALE') continue;
      this.onSale.push(item);
      const keys = [item.code, item.price ? item.price.sku : undefined, item.price ? item.price.barcode : undefined];
      for (const k of keys) {
        if (typeof k === 'string' && k !== '' && !this.catalogIndex.has(k)) this.catalogIndex.set(k, item);
      }
    }
  }

  /**
   * 밑판 선택: (a) 상품코드 매칭(설정 켜짐) -> (b) [기본 상품 코드] 상품 -> (c) 판매 중 첫 상품.
   * fallback 은 (a) 로 골랐을 때 실패 재시도에 쓸 (b)/(c) 밑판이다.
   */
  private async pickBases(
    productCode: string,
  ): Promise<{ primary: CatalogItemLike; fallback: CatalogItemLike | null }> {
    await this.ensureCatalog();
    const matched =
      this.settings.matchCatalog && productCode !== '' ? (this.catalogIndex.get(productCode) ?? null) : null;
    const code = this.settings.defaultItemCode;
    const def = code !== '' ? (this.catalogIndex.get(code) ?? null) : null;
    const fallback = def ?? this.onSale[0] ?? null;
    const primary = matched ?? fallback;
    if (!primary) throw new Error(NO_CATALOG_MESSAGE);
    return { primary, fallback: matched && fallback && fallback !== matched ? fallback : null };
  }

  // ---- draft 이벤트 ------------------------------------------------------

  /**
   * 결제-작업 연결 기억(`attrib`)을 draft 관찰 결과로 갱신한다.
   *  - gm- 라인이 있으면 그 작업들로 교체하고 goneAt 을 지운다.
   *  - gm- 없이 다른(POS 에서 직접 담은) 라인만 있으면 작업 ID 를 비운다: 이 결제는 전산과 무관하다.
   *  - draft 가 비었으면 작업 ID 는 그대로 두고, goneAt 이 비어 있을 때만 지금 시각을 기록한다.
   *    (POS 는 결제가 끝나면 draft 를 비운다. 그 뒤 5분 안에 paid 이벤트가 오면 방금 비워진 작업의 결제로 본다.)
   */
  private observeDraft(d: DraftLike): void {
    const summary = this.summarize(d);
    if (summary.ourKeys.length > 0) {
      this.attrib = { ids: summary.workOrderIds, goneAt: null };
    } else if (d.lineItems.length > 0) {
      this.attrib = { ids: [], goneAt: null };
    } else if (this.attrib.goneAt === null) {
      this.attrib = { ids: this.attrib.ids, goneAt: this.clock.now() };
    }
  }

  /**
   * 명령 처리가 끝난 시점의 draft(= SDK 변경 메서드가 돌려준 값)로도 기억을 갱신한다.
   * POS 가 플러그인 자신의 변경에는 update 이벤트를 보내지 않을 수도 있어서(e2e 시나리오 k) 이벤트만으로는
   * 결제를 작업에 연결하지 못할 수 있다. 변경 메서드가 실패해 캐시를 버렸으면(draft 없음) 건드리지 않는다.
   */
  private noteCommandResult(): void {
    if (!this.draft) return;
    this.observeDraft(this.draft);
  }

  onDraftUpdate(d: DraftLike): void {
    this.draft = d;
    this.observeDraft(d);
    this.changed();
    // 명령 처리 중에는 보고하지 않는다(마지막 ack 의 draft 가 최종 상태를 알려 준다).
    if (this.busy) return;
    this.pruneKeymap(d);
    this.scheduleDraftReport();
  }

  private scheduleDraftReport(): void {
    if (this.stopped || !this.draft) return;
    const summary = this.summarize(this.draft);
    const sig = summarySignature(summary);
    if (sig === this.lastSentSig) return;
    const now = this.clock.now();
    const elapsed = now - this.lastDraftSentAt;
    if (elapsed >= DRAFT_THROTTLE_MS) {
      this.lastSentSig = sig;
      this.lastDraftSentAt = now;
      this.emit({ type: 'draft', draft: summary });
    } else if (this.draftTimer === null) {
      this.draftTimer = this.clock.setTimeout(() => {
        this.draftTimer = null;
        this.scheduleDraftReport();
      }, DRAFT_THROTTLE_MS - elapsed);
    }
  }

  // ---- 결제 이벤트 -------------------------------------------------------

  async onPaid(paymentId: string, orderId: string): Promise<void> {
    if (this.handledPayments.includes(paymentId)) return; // 같은 결제는 한 번만 처리(getOrder 재시도는 그 안에서)
    this.handledPayments.push(paymentId);
    if (this.handledPayments.length > HANDLED_PAYMENTS_MAX) this.handledPayments.shift();

    // 어느 작업의 결제인지는 "결제된 주문의 항목 메모(#작업ID)"로 정한다(아래 getOrder 결과). 그 순간 장바구니에
    // 무엇이 있었는지로 정하면, 다른 주문의 결제가 담겨 있던 작업에 붙거나 탭이 다시 로드된 뒤 작업을 잃는다.
    // 주문을 조회하지 못했거나 응답에 항목 목록이 없을 때만 아래의 draft 기억을 대신 쓴다:
    // 결제가 끝나면 draft 가 비워지므로 이벤트 시점에 바로 잡아 두고, draft 에 우리 라인이 남아 있는 동안은
    // 시간 제한 없이, draft 가 비워진 뒤에는 5분 안에 온 결제만 연결한다.
    const capturedIds = [...this.attrib.ids];
    const goneAt = this.attrib.goneAt;
    const usable = goneAt === null || this.clock.now() - goneAt <= ATTRIB_WINDOW_MS;
    const rememberedIds = usable ? [...capturedIds] : [];
    let orderIds: number[] | null = null; // 주문 항목 메모에서 읽은 작업 ID(읽지 못했으면 null)

    // getOrder 는 SDK 공유 호출 제한을 받아 일시 실패할 수 있으므로 최대 PAYMENT_LOOKUP_ATTEMPTS 회 시도한다.
    // 호출 제한 오류는 RATE_LIMIT_WAIT_MS, 그 외(타임아웃 포함)는 PAYMENT_LOOKUP_RETRY_MS 만큼 기다린 뒤 다시 부른다.
    // 대기 뒤 stop 되었으면 더 시도하지 않고 "확인 실패"로 보고한다(sendPayment 가 storage 에 보존하므로 알림은 잃지 않는다).
    let checked = false;
    let fullyPaid = false;
    let paidValue = 0;
    let unpaidValue = -1;
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= PAYMENT_LOOKUP_ATTEMPTS; attempt++) {
      try {
        const order = await this.sdk.order.getOrder(orderId);
        const unpaid = order.paymentPrice.paymentUnpaidValue;
        const paid = order.paymentPrice.paymentPaidValue;
        if (typeof unpaid !== 'number' || typeof paid !== 'number') {
          throw new Error('주문의 결제 금액 정보를 알 수 없어요');
        }
        unpaidValue = unpaid;
        paidValue = paid;
        fullyPaid = unpaid === 0;
        if (Array.isArray(order.lineItems)) orderIds = workOrderIdsOf(order);
        checked = true;
        break;
      } catch (e) {
        lastError = e;
        if (attempt >= PAYMENT_LOOKUP_ATTEMPTS || this.stopped) break;
        this.logLocal(
          'warn',
          `결제 ${paymentId} 의 주문(${orderId}) 조회 실패, 다시 시도해요 (${attempt}/${PAYMENT_LOOKUP_ATTEMPTS}): ${errText(e)}`,
        );
        await this.sleeper.sleep(isRateLimitError(e) ? RATE_LIMIT_WAIT_MS : PAYMENT_LOOKUP_RETRY_MS);
        if (this.stopped) break;
      }
    }
    if (!checked) {
      // 확인하지 못한 결제를 "전액 결제"로 간주하지 않는다.
      this.report('warn', `결제 ${paymentId} 의 주문(${orderId})을 조회하지 못했어요: ${errText(lastError)}`);
    }
    const workOrderIds = orderIds ?? rememberedIds;
    this.sendPayment({ type: 'payment.paid', paymentId, orderId, workOrderIds, fullyPaid, paidValue, unpaidValue });
    if (fullyPaid && workOrderIds.length > 0) await this.paywatch.removeFor(workOrderIds);
    // 전액 결제가 확인됐거나 확인에 실패했으면 기억을 비운다(같은 작업 ID 가 전산과 무관한 다음 결제에 붙지 않게).
    // 부분 결제는 남은 금액을 같은 작업으로 치르므로 유지한다.
    // getOrder 를 기다리는 동안 새 작업의 라인이 담겼다면(기억이 바뀌었다면) 그것은 지우지 않는다.
    // 주문 항목으로 보아 기억해 둔 작업과 무관한 결제(전산과 무관하거나 다른 작업의 주문)였으면 기억을 건드리지 않는다:
    // 담겨 있는 작업은 아직 결제 전이다.
    const aboutRemembered = orderIds === null || orderIds.some((id) => capturedIds.includes(id));
    if (aboutRemembered && (fullyPaid || !checked) && sameNumbers(this.attrib.ids, capturedIds)) {
      this.attrib = { ids: [], goneAt: null };
    }
  }

  onCancel(paymentId: string, orderId: string): void {
    this.sendPayment({ type: 'payment.cancelled', paymentId, orderId });
  }
}

export function createBridge(options: BridgeOptions): Bridge {
  return new BridgeImpl(options);
}
