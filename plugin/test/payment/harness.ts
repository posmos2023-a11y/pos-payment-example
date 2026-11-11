// bridge 테스트용 하네스: 가짜 전송 계층 + 명령 생성 도우미.
import { createBridge } from '../../src/payment/bridge.ts';
import type { Bridge, BridgeOptions, TransportContext } from '../../src/payment/bridge.ts';
import type {
  AckMessage,
  CartLine,
  Command,
  PluginMessage,
  ServerMessage,
  SyncCartPayload,
  TransportKind,
} from '../../src/payment/protocol.ts';
import type { SettingValue } from '../../src/payment/sdk-types.ts';
import type { Transport, TransportHandlers } from '../../src/payment/transport.ts';
import { FakeClock, settle } from './fake-clock.ts';
import { FakeSdk } from './fake-sdk.ts';

export class FakeTransport implements Transport {
  kind: TransportKind = 'ws';
  handlers!: TransportHandlers;
  started = false;
  stopped = false;
  online = false;
  rejectSends = false;
  sent: PluginMessage[] = [];

  start(handlers: TransportHandlers): void {
    this.handlers = handlers;
    this.started = true;
  }
  send(msg: PluginMessage): boolean {
    if (!this.online || this.rejectSends) return false;
    this.sent.push(msg);
    return true;
  }
  stop(): Promise<void> {
    this.stopped = true;
    this.online = false;
    return Promise.resolve();
  }

  goOnline(): void {
    this.online = true;
    this.handlers.onStatus({ kind: this.kind, online: true });
  }
  goOffline(): void {
    this.online = false;
    this.handlers.onStatus({ kind: this.kind, online: false, failed: true });
  }
  serverSend(msg: ServerMessage): void {
    this.handlers.onMessage(msg);
  }
  sendCommand(cmd: Command): void {
    this.serverSend({ type: 'command', command: cmd });
  }
  of<T extends PluginMessage['type']>(type: T): Extract<PluginMessage, { type: T }>[] {
    return this.sent.filter((m) => m.type === type) as Extract<PluginMessage, { type: T }>[];
  }
  acks(): AckMessage[] {
    return this.of('ack');
  }
}

// ---- 명령 / 라인 도우미 -------------------------------------------------------

let seqCounter = 0;

export function line(
  workOrderId: number,
  lineId: number,
  opts: Partial<CartLine> & { quantity?: number; unitPrice?: number } = {},
): CartLine {
  return {
    key: `gm-${workOrderId}-${lineId}`,
    productCode: `P-${lineId}`,
    title: `상품${lineId}`,
    category: '소모품',
    unitPrice: 10000,
    quantity: 1,
    taxFree: false,
    ...opts,
  };
}

export function syncCmd(
  workOrderId: number,
  lines: CartLine[],
  opts: Partial<SyncCartPayload> & { id?: string } = {},
): Command {
  const seq = ++seqCounter;
  const { id, ...payloadOpts } = opts;
  return {
    id: id ?? `cmd-${seq}`,
    seq,
    kind: 'SYNC_CART',
    createdAt: '2026-11-03T09:00:00',
    payload: {
      workOrderId,
      label: `${workOrderId}가1234 홍길동`,
      lines,
      startPayment: false,
      exclusive: true,
      ...payloadOpts,
    },
  };
}

export function clearCmd(id?: string): Command {
  const seq = ++seqCounter;
  return {
    id: id ?? `cmd-${seq}`,
    seq,
    kind: 'CLEAR_CART',
    createdAt: '2026-11-03T09:00:00',
    payload: { scope: 'ours' },
  };
}

// ---- 하네스 ----------------------------------------------------------------

export interface Harness {
  clock: FakeClock;
  sdk: FakeSdk;
  bridge: Bridge;
  transport: FakeTransport;
  transports: FakeTransport[];
  /** transportFactory 가 받은 문맥(설정/clientId/getHello) */
  ctxs: TransportContext[];
  logs: [string, string][];
  /** 명령을 보내고 처리가 끝날 때까지 기다린다 */
  run(cmd: Command): Promise<void>;
  lastAck(): AckMessage;
  ackFor(commandId: string): AckMessage | undefined;
}

export interface HarnessOptions {
  settings?: Record<string, SettingValue>;
  /** true(기본): start() 후 전송 계층을 online 으로 만든다 */
  online?: boolean;
  bridge?: Partial<BridgeOptions>;
  sdk?: FakeSdk;
  clock?: FakeClock;
  /** false 면 start() 하지 않는다 */
  start?: boolean;
  /** false 면 SDK 이벤트(draft/payment/setting/catalog)를 bridge 에 연결하지 않는다(index.ts 와 같은 연결이 기본) */
  wire?: boolean;
}

export async function createHarness(opts: HarnessOptions = {}): Promise<Harness> {
  const clock = opts.clock ?? new FakeClock();
  const sdk = opts.sdk ?? new FakeSdk();
  sdk.settingValues = {
    serverUrl: 'http://192.168.0.10:8765',
    token: '',
    transport: 'ws',
    allowStartPayment: true,
    matchCatalog: true,
    showToast: true,
    ...opts.settings,
  };
  const transports: FakeTransport[] = [];
  const ctxs: TransportContext[] = [];
  const logs: [string, string][] = [];
  let nonceSeq = 0;
  const bridge = createBridge({
    sdk,
    clock,
    transportFactory: (ctx) => {
      ctxs.push(ctx);
      const t = new FakeTransport();
      transports.push(t);
      return t;
    },
    log: (level, message) => logs.push([level, message]),
    pluginVersion: '1.0.0',
    randomId: () => 'pos-test-client-0001',
    // POS key 꼬리(nonce): n0000001, n0000002 ... (영숫자 8자)
    randomNonce: () => `n${String(++nonceSeq).padStart(7, '0')}`,
    ...opts.bridge,
  });
  if (opts.wire !== false) {
    // index.ts 와 같은 이벤트 연결
    sdk.draftOrder.on('update', (d) => bridge.onDraftUpdate(d));
    sdk.payment.on('paid', (p, o) => {
      void bridge.onPaid(p, o);
    });
    sdk.payment.on('cancel', (p, o) => bridge.onCancel(p, o));
    sdk.setting.on('change', () => {
      void bridge.reloadSettings();
    });
    sdk.catalog.on('add', () => bridge.markCatalogStale());
    sdk.catalog.on('update', () => bridge.markCatalogStale());
    sdk.catalog.on('delete', () => bridge.markCatalogStale());
  }
  if (opts.start !== false) {
    await bridge.start();
    await settle();
    if (opts.online !== false && transports[0]) transports[0].goOnline();
    await settle();
  }
  const h: Harness = {
    clock,
    sdk,
    bridge,
    get transport() {
      return transports[transports.length - 1]!;
    },
    transports,
    ctxs,
    logs,
    async run(cmd) {
      h.transport.sendCommand(cmd);
      await settle();
    },
    lastAck() {
      const acks = h.transport.acks();
      return acks[acks.length - 1]!;
    },
    ackFor(commandId) {
      return h.transport.acks().find((a) => a.commandId === commandId);
    },
  };
  return h;
}
