import { Unavailability } from './unavailability.entity';

export interface CartItemView {
  recordUuid: string;
  offerUuid: string | null;
  productUuid: string | null;
  variantUuid: string | null;
  productName: string | null;
  variantName: string | null;
  article: string | null;
  clarifications: string[];
  imageUuid: string | null;
  quantity: number;
  version: string;
  checkoutUuid: string | null;
  available: number | null;
  price: { uuid: string; value: string; currencyCode: string } | null;
  subtotal: string | null;
  reasons: Unavailability[];
  message: string | null;
  canCheckout: boolean;
  canOpenProduct: boolean;
  canIncrease: boolean;
  canDecrease: boolean;
  canRemove: boolean;
  sourceVersions: { product: number | null; store: number | null; inventory: number | null };
}
