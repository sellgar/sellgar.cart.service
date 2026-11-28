import { IsUUID } from 'class-validator';

import { CartScopeDto } from '../../api/v1/cart/controller/dto/cart-scope.dto';

export class CheckoutCompletedPayload extends CartScopeDto {
  @IsUUID() cartUuid: string;
}
