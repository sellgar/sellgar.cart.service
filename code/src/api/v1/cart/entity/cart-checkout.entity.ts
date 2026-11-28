import { CheckoutStatus } from '../enum/checkout-status.enum';

export interface CartCheckoutEntity {
  checkoutUuid: string;
  cartUuid: string;
  status: CheckoutStatus;
}
