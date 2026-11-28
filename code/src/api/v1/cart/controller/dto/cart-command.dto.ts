import { IsUUID } from 'class-validator';

import { CartScopeDto } from './cart-scope.dto';

export class CartCommandDto extends CartScopeDto {
  @IsUUID() idempotencyKey: string;
}
