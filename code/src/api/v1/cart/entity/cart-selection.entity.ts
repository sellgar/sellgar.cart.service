import { CartSelectionItemEntity } from './cart-selection-item.entity';

export interface CartSelectionEntity {
  cartUuid: string;
  ownerUuid: string;
  shop: { uuid: string; name: string };
  currencyCode: string;
  items: CartSelectionItemEntity[];
  itemsTotal: string;
}
