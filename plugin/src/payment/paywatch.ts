// 결제 대기 기록. startPayment() 를 부르면 탭이 가려지거나 다시 로드될 수 있어서,
// 결제 화면을 열기 *전에* "이 작업들을 결제하러 갔다"는 기록을 storage 에 남긴다.
// 탭을 다시 열면 reconcile.ts 가 이 기록을 보고 최근 주문에서 놓친 결제를 찾는다.
import type { Clock } from './clock.ts';
import type { StorageLike } from './sdk-types.ts';

export const PAYWATCH_KEY = 'gm.paywatch';
export const PAYWATCH_MAX = 20;
export const PAYWATCH_MAX_AGE_MS = 3 * 60 * 60_000;

export interface PaywatchEntry {
  workOrderIds: number[];
  keys: string[];
  total: number;
  /** ISO 시각 */
  at: string;
}

function isNumberArray(v: unknown): v is number[] {
  return Array.isArray(v) && v.every((n) => typeof n === 'number' && Number.isFinite(n));
}

function parseEntry(v: unknown): PaywatchEntry | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  if (!isNumberArray(o.workOrderIds) || o.workOrderIds.length === 0) return null;
  if (!Array.isArray(o.keys) || !o.keys.every((k) => typeof k === 'string')) return null;
  if (typeof o.total !== 'number' || !Number.isFinite(o.total)) return null;
  if (typeof o.at !== 'string' || Number.isNaN(Date.parse(o.at))) return null;
  return { workOrderIds: [...o.workOrderIds], keys: [...(o.keys as string[])], total: o.total, at: o.at };
}

/** 만료(3시간)된 것을 버리고 최근 20개만 남긴다. */
export function prunePaywatch(list: readonly PaywatchEntry[], nowMs: number): PaywatchEntry[] {
  return list.filter((e) => nowMs - Date.parse(e.at) <= PAYWATCH_MAX_AGE_MS).slice(-PAYWATCH_MAX);
}

/** storage 에서 읽은 JSON 문자열 -> 유효한 기록(만료 제외). 잘못된 값이면 []. */
export function parsePaywatch(raw: unknown, nowMs: number): PaywatchEntry[] {
  if (typeof raw !== 'string' || raw === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: PaywatchEntry[] = [];
  for (const item of parsed as unknown[]) {
    const e = parseEntry(item);
    if (e) out.push(e);
  }
  return prunePaywatch(out, nowMs);
}

function sameIds(a: readonly number[], b: readonly number[]): boolean {
  const sa = [...new Set(a)].sort((x, y) => x - y);
  const sb = [...new Set(b)].sort((x, y) => x - y);
  return sa.length === sb.length && sa.every((n, i) => n === sb[i]);
}

/** 같은 작업 ID 집합이면 갱신(뒤로 옮김), 아니면 추가한다. */
export function upsertPaywatch(list: readonly PaywatchEntry[], entry: PaywatchEntry, nowMs: number): PaywatchEntry[] {
  const rest = list.filter((e) => !sameIds(e.workOrderIds, entry.workOrderIds));
  return prunePaywatch([...rest, entry], nowMs);
}

/** 주어진 작업 ID 와 하나라도 겹치는 기록을 지운다. */
export function removePaywatchFor(list: readonly PaywatchEntry[], workOrderIds: readonly number[]): PaywatchEntry[] {
  const ids = new Set(workOrderIds);
  return list.filter((e) => !e.workOrderIds.some((id) => ids.has(id)));
}

/** storage 에 저장하는 결제 대기 기록. 저장은 직렬화한다. */
export class PaywatchStore {
  private list: PaywatchEntry[] = [];
  private chain: Promise<void> = Promise.resolve();
  private readonly storage: StorageLike;
  private readonly clock: Clock;
  private readonly log: (message: string) => void;

  constructor(storage: StorageLike, clock: Clock, log: (message: string) => void = () => {}) {
    this.storage = storage;
    this.clock = clock;
    this.log = log;
  }

  async load(): Promise<void> {
    try {
      this.list = parsePaywatch(await this.storage.get(PAYWATCH_KEY), this.clock.now());
    } catch (e) {
      this.list = [];
      this.log(`결제 대기 기록을 읽지 못했어요: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  entries(): PaywatchEntry[] {
    this.list = prunePaywatch(this.list, this.clock.now());
    return [...this.list];
  }

  /** 기록을 추가/갱신하고 저장이 끝날 때까지 기다린다(startPayment 호출 전에 await 한다). */
  async add(entry: { workOrderIds: number[]; keys: string[]; total: number }): Promise<void> {
    const now = this.clock.now();
    this.list = upsertPaywatch(
      this.list,
      { workOrderIds: [...entry.workOrderIds], keys: [...entry.keys], total: entry.total, at: new Date(now).toISOString() },
      now,
    );
    await this.persist();
  }

  /** 겹치는 작업의 기록을 지운다. 지운 것이 있으면 저장한다. */
  async removeFor(workOrderIds: readonly number[]): Promise<void> {
    const before = this.list.length;
    this.list = removePaywatchFor(this.list, workOrderIds);
    if (this.list.length !== before) await this.persist();
  }

  private persist(): Promise<void> {
    this.chain = this.chain
      .then(() => this.storage.set(PAYWATCH_KEY, JSON.stringify(this.list)))
      .catch((e) => {
        this.log(`결제 대기 기록을 저장하지 못했어요: ${e instanceof Error ? e.message : String(e)}`);
      });
    return this.chain;
  }
}
