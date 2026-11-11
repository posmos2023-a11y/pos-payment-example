// 표시용 서식 함수(순수 함수).

/** 10000 -> "10,000원" */
export function formatWon(n: number): string {
  return `${Math.round(n).toLocaleString('en-US')}원`;
}

/** ISO8601("2026-11-04T10:30:00+09:00")에서 시각("10:30")만. 실패하면 ''. */
export function formatTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const m = /T(\d{2}:\d{2})/.exec(iso);
  return m ? m[1]! : '';
}
