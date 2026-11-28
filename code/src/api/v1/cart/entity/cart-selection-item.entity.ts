export interface CartSelectionItemEntity {
  recordUuid: string;
  offerUuid: string;
  productUuid: string;
  variantUuid: string;
  productName: string;
  variantName: string;
  article: string | null;
  clarifications: string[];
  imageUuid: string | null;
  quantity: number;
  expectedItemVersion: string;
  unitPrice: { uuid: string; value: string; currencyCode: string };
  subtotal: string;
}
