import { CartItemView } from './cart-item-view.entity';

export interface CartView {
  uuid: string;
  ownerUuid: string;
  version: string;
  shop: { uuid: string; name: string | null; sourceVersion: number | null };
  items: CartItemView[];
  currencyCode: string;
  itemsTotal: string | null;
}
