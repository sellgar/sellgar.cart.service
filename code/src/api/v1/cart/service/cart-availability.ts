import { CartItemView } from '../entity/cart-item-view.entity';
import { CartLineRow } from '../entity/cart-line-row.entity';
import { Unavailability } from '../entity/unavailability.entity';
import { multiplyPrice } from './money';

const messages: Record<Unavailability, string> = {
  not_sold: 'Товар больше не продается',
  hidden: 'Временно недоступен',
  sync_pending: 'Данные уточняются',
  price_missing: 'Цена недоступна',
  currency_mismatch: 'Валюта товара недоступна',
  out_of_stock: 'Нет в наличии',
  insufficient_stock: 'Выбранное количество недоступно',
  checkout_in_progress: 'Оформляется',
};

export function cartItemView(row: CartLineRow, shopUuid: string, currency: string): CartItemView {
  const reasons: Unavailability[] = [];
  if (
    [row.product_status, row.variant_status].includes('archived') ||
    [row.store_product_status, row.offer_status].some((s) => s === 'disabled' || s === 'archived')
  )
    reasons.push('not_sold');
  if (row.product_showing === false || row.offer_showing === false) reasons.push('hidden');

  const complete =
    row.record_exists &&
    row.shop_uuid === shopUuid &&
    row.shop_name !== null &&
    row.product_name !== null &&
    row.variant_name !== null &&
    row.store_version !== null &&
    row.available !== null;
  if (!complete || row.sync_pending) reasons.push('sync_pending');
  if (row.price_uuid === null || row.price_value === null || row.currency_code === null)
    reasons.push('price_missing');
  else if (row.currency_code !== currency) reasons.push('currency_mismatch');
  if (row.available === 0) reasons.push('out_of_stock');
  else if (row.available !== null && row.quantity > row.available) reasons.push('insufficient_stock');
  if (row.checkout_uuid !== null) reasons.push('checkout_in_progress');

  const price =
    row.price_uuid !== null && row.price_value !== null && row.currency_code !== null
      ? { uuid: row.price_uuid, value: row.price_value, currencyCode: row.currency_code }
      : null;
  const blocked = row.checkout_uuid !== null;
  const unavailable = reasons.some((r) => r !== 'insufficient_stock' && r !== 'checkout_in_progress');

  return {
    recordUuid: row.record_uuid,
    offerUuid: row.offer_uuid,
    productUuid: row.product_uuid,
    variantUuid: row.variant_uuid,
    productName: row.product_name,
    variantName: row.variant_name,
    article: row.article,
    clarifications: row.clarifications ?? [],
    imageUuid: row.image_uuid,
    quantity: row.quantity,
    version: row.version,
    checkoutUuid: row.checkout_uuid,
    available: row.available,
    price,
    subtotal: price ? multiplyPrice(price.value, row.quantity) : null,
    reasons,
    message: reasons.length ? messages[reasons[0]] : null,
    canCheckout: reasons.length === 0,
    canOpenProduct: !reasons.some((r) => ['not_sold', 'hidden', 'sync_pending', 'out_of_stock'].includes(r)),
    canIncrease: !blocked && !unavailable && row.available !== null && row.quantity < row.available,
    canDecrease: !blocked && !unavailable && row.quantity > 1,
    canRemove: !blocked,
    sourceVersions: {
      product: row.product_version,
      store: row.store_version,
      inventory: row.inventory_version,
    },
  };
}
