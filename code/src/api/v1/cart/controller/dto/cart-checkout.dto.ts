import { IsUUID } from 'class-validator';

import { GetCartCheckoutDto } from './get-cart-checkout.dto';

export class CartCheckoutDto extends GetCartCheckoutDto {
  @IsUUID() idempotencyKey: string;
}
