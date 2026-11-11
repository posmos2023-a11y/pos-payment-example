/** 어떤 예외든 화면에 보일 문구로. */
export function describeError(e: unknown): string {
  if (e instanceof Error && e.message) return e.message;
  return '알 수 없는 오류가 났어요';
}
