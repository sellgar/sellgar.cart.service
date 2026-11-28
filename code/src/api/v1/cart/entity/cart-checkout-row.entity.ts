import { CheckoutStatus } from '../enum/checkout-status.enum';

export interface CartCheckoutRow {
  checkout_uuid: string;
  cart_uuid: string;
  status: CheckoutStatus;
  request_hash: string | null;
}
