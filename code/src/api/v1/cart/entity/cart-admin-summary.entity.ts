import { CartAdminMetadata } from './cart-admin-metadata.entity';

export interface CartAdminSummary extends CartAdminMetadata {
  uuid: string;
  ownerUuid: string;
  version: string;
  shop: { uuid: string; name: string | null };
  itemsCount: number;
}
