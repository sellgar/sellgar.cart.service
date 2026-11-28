import { IsString, Matches } from 'class-validator';

import { AddCartItemDto } from './add-cart-item.dto';

export class SetCartItemDto extends AddCartItemDto {
  @IsString() @Matches(/^[1-9]\d*$/) expectedItemVersion: string;
}
