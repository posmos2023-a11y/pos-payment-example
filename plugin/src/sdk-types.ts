// 화면 코드가 의존하는 "최소 SDK 인터페이스".
// 실제 posPluginSdk 는 src/sdk.ts 에서 이 인터페이스에 대입된다(타입 검사로 보장).
// 테스트에서는 가짜 객체를 넣는다.

export interface StorageLike {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  del(key: string): Promise<void>;
}

export type SecureStoreLike = StorageLike;

export interface ToastLike {
  success(message: string): void;
  error(message: string): void;
  warn(message: string): void;
}

export interface Services {
  storage: StorageLike;
  secureStore: SecureStoreLike;
  toast: ToastLike;
}
