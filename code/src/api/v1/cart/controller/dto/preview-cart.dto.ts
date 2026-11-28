import { Type } from 'class-transformer';
import { ArrayMinSize, ArrayUnique, IsArray, IsUUID, ValidateNested } from 'class-validator';

import { CartScopeDto } from './cart-scope.dto';
import { CheckoutItemDto } from './checkout-item.dto';

export class PreviewCartDto extends CartScopeDto {
  @IsUUID() cartUuid: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique((item: CheckoutItemDto) => item.recordUuid)
  @ValidateNested({ each: true })
  @Type(() => CheckoutItemDto)
  items: CheckoutItemDto[];
}
