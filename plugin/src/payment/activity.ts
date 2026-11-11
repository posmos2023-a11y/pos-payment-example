// 최근 처리 내역: 전산 명령 처리 결과를 최근 20개 보관한다(메모리 + storage).
export const ACTIVITY_KEY = 'gm.activity';
export const ACTIVITY_MAX = 20;

export type ActivityResult = 'added' | 'cleared' | 'paying' | 'failed' | 'skipped';

export interface ActivityEntry {
  /** ISO 시각 */
  at: string;
  /** 작업 label(없으면 빈 문자열) */
  label: string;
  result: ActivityResult;
  /** 실패 사유 등 */
  detail?: string;
}

const RESULTS: readonly string[] = ['added', 'cleared', 'paying', 'failed', 'skipped'];

export function parseActivity(raw: unknown): ActivityEntry[] {
  if (typeof raw !== 'string' || raw === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: ActivityEntry[] = [];
  for (const item of parsed as unknown[]) {
    if (typeof item !== 'object' || item === null) continue;
    const o = item as Record<string, unknown>;
    if (typeof o.at !== 'string' || typeof o.label !== 'string' || typeof o.result !== 'string') continue;
    if (!RESULTS.includes(o.result)) continue;
    const e: ActivityEntry = { at: o.at, label: o.label, result: o.result as ActivityResult };
    if (typeof o.detail === 'string') e.detail = o.detail;
    out.push(e);
  }
  return out.slice(-ACTIVITY_MAX);
}

export function addActivity(list: readonly ActivityEntry[], entry: ActivityEntry): ActivityEntry[] {
  return [...list, entry].slice(-ACTIVITY_MAX);
}

export const ACTIVITY_TEXT: Record<ActivityResult, string> = {
  added: '담았어요',
  cleared: '비웠어요',
  paying: '결제 시작',
  failed: '실패',
  skipped: '건너뜀',
};
