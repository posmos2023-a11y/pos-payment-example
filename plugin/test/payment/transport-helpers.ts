import type { PluginMessage, ServerMessage } from '../../src/payment/protocol.ts';
import type { Transport, TransportDeps, TransportStatus } from '../../src/payment/transport.ts';
import type { FakeClock } from './fake-clock.ts';
import type { FakeSdk } from './fake-sdk.ts';

export interface TransportRig {
  deps: TransportDeps;
  messages: ServerMessage[];
  statuses: TransportStatus[];
  logs: [string, string][];
  notifications: [string, string][];
  start(transport: Transport): void;
}

export function makeRig(sdk: FakeSdk, clock: FakeClock, over: Partial<TransportDeps> = {}): TransportRig {
  const logs: [string, string][] = [];
  const notifications: [string, string][] = [];
  const messages: ServerMessage[] = [];
  const statuses: TransportStatus[] = [];
  const deps: TransportDeps = {
    sdk,
    clock,
    wsUrl: 'ws://host:8765/pos/ws',
    httpBase: 'http://host:8765',
    token: '',
    clientId: 'client-1',
    getHello: (kind) => ({
      type: 'hello',
      clientId: 'client-1',
      pluginName: 'example-test',
      pluginVersion: '1.0.0',
      transport: kind,
      processedIds: ['cmd-1', 'cmd-2'],
    }),
    log: (level, message) => logs.push([level, message]),
    notify: (level, message) => notifications.push([level, message]),
    ...over,
  };
  return {
    deps,
    messages,
    statuses,
    logs,
    notifications,
    start(transport) {
      transport.start({
        onMessage: (m) => messages.push(m),
        onStatus: (s) => statuses.push(s),
      });
    },
  };
}

export const WELCOME: ServerMessage = { type: 'welcome', serverVersion: '1.0.0', serverTime: '2026-11-03T09:00:00' };

export const ACK_MSG: PluginMessage = { type: 'ack', commandId: 'cmd-9', ok: true, draft: null };
