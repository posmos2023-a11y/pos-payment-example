// 시간/타이머 추상화. 모든 타이머는 이 인터페이스를 통해서만 만든다(테스트에서 가짜 시계를 주입).

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as number),
};

/** 취소 가능한 sleep. cancelAll() 은 대기 중인 sleep 을 즉시 풀어 준다(호출한 쪽이 중단 여부를 직접 확인). */
export class Sleeper {
  private readonly clock: Clock;
  private readonly waiters = new Set<() => void>();

  constructor(clock: Clock) {
    this.clock = clock;
  }

  sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      let handle: unknown = null;
      const done = (): void => {
        this.waiters.delete(done);
        this.clock.clearTimeout(handle);
        resolve();
      };
      handle = this.clock.setTimeout(done, ms);
      this.waiters.add(done);
    });
  }

  cancelAll(): void {
    for (const done of [...this.waiters]) done();
  }
}
