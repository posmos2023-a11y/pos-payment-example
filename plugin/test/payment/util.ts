/** 배열의 마지막 요소(Array.prototype.at 은 es2022 라 쓰지 않는다). 비어 있으면 오류. */
export function last<T>(arr: readonly T[]): T {
  if (arr.length === 0) throw new Error('빈 배열');
  return arr[arr.length - 1] as T;
}
