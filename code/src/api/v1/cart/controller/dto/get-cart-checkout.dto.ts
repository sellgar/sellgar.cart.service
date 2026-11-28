import { IsUUID } from 'class-validator';

import { CartScopeDto } from './cart-scope.dto';

export class GetCartCheckoutDto extends CartScopeDto {
  @IsUUID() cartUuid: string;
  @IsUUID() checkoutUuid: string;
}
