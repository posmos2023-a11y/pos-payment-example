import { setImmediate as nextMacrotask } from 'node:timers/promises';
import type { Clock } from '../../src/payment/clock.ts';

/** 대기 중인 마이크로태스크(Promise 체인)를 모두 소진시킨다. */
export async function settle(rounds = 3): Promise<void> {
  for (let i = 0; i < rounds; i++) await nextMacrotask();
}

interface Timer {
  at: number;
  fn: () => void;
}

/** 결정적인 가짜 시계. advance() 가 시간 순서대로 타이머를 실행하고 매번 Promise 체인을 소진시킨다. */
export class FakeClock implements Clock {
  private t: number;
  private seq = 0;
  private readonly timers = new Map<number, Timer>();

  constructor(start = Date.UTC(2026, 10, 3, 9, 0, 0)) {
    this.t = start;
  }

  now(): number {
    return this.t;
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.seq;
    this.timers.set(id, { at: this.t + Math.max(0, ms), fn });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  get pendingTimers(): number {
    return this.timers.size;
  }

  async advance(ms: number): Promise<void> {
    const target = this.t + ms;
    await settle();
    for (;;) {
      let nextId = -1;
      let next: Timer | null = null;
      for (const [id, tm] of this.timers) {
        if (tm.at > target) continue;
        if (next === null || tm.at < next.at || (tm.at === next.at && id < nextId)) {
          next = tm;
          nextId = id;
        }
      }
      if (next === null) break;
      this.timers.delete(nextId);
      this.t = Math.max(this.t, next.at);
      next.fn();
      await settle();
    }
    this.t = target;
    await settle();
  }
}
