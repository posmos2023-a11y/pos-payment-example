// addLineItem DTO 만들기. 실제 POS 에서 확인된 규칙을 한 곳에 모은다.
//  - item/itemPrice 는 최소 필드로 만들면 addLineItem 은 성공하지만 POS [주문] 화면이 깨진다
//    -> POS 카탈로그 상품 원본 객체 전체를 밑판으로 쓰고 화면에 보이는 값(이름·금액)만 바꾼다.
//  - SDK 스키마는 null 인 titleI18n/descriptionI18n 을 거부한다 -> 넘기기 전에 지운다.
//  - memo 는 undefined 가 아니라 '' 이다. key 는 직접 발급해야 한다(우리는 gm-{작업ID}-{라인ID}).
import type { CartLine } from './protocol.ts';
import type { CatalogItemLike, LineItemDto } from './sdk-types.ts';

const NULLABLE_I18N_KEYS = ['titleI18n', 'descriptionI18n'];

/** null 인 i18n 필드만 지운다(중첩된 category/price 안쪽까지). 원본은 건드리지 않고 다른 null 은 그대로 둔다. */
export function stripNullI18n<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => stripNullI18n(v)) as unknown as T;
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (NULLABLE_I18N_KEYS.includes(k) && v === null) continue;
    out[k] = stripNullI18n(v);
  }
  return out as T;
}

/** 카탈로그 상품 하나를 밑판 삼아 화면에 보이는 값만 갈아끼운 DTO. */
export function buildLineItemDto(base: CatalogItemLike, line: CartLine, memo: string): LineItemDto {
  // getCatalogs() 가 주는 가격이 price(단수)일 수도 prices(배열)일 수도 있어 둘 다 받는다.
  const prices = (base as unknown as { prices?: Record<string, unknown>[] }).prices;
  const basePrice: Record<string, unknown> =
    (base.price as unknown as Record<string, unknown> | undefined) ?? (Array.isArray(prices) ? prices[0] : undefined) ?? {};
  const baseTitle = basePrice.title;
  const dto = {
    key: line.key,
    item: { ...base, type: 'ITEM' as const, title: line.title, options: base.options ?? [] },
    itemPrice: {
      priceType: 'FIXED' as const, // 밑판 가격에 값이 있으면 아래 spread 가 덮어쓴다
      priceUnit: 1,
      ...basePrice,
      priceValue: line.unitPrice,
      title: typeof baseTitle === 'string' ? baseTitle : '기본',
      isTaxFree: line.taxFree,
    },
    discount: [] as never[],
    memo,
    optionChoices: [] as never[],
    quantity: line.quantity,
    diningOption: 'HERE' as const,
  };
  return stripNullI18n(dto) as LineItemDto;
}
