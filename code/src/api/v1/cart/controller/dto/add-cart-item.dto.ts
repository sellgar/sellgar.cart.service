import { IsInt, IsUUID, Max, Min } from 'class-validator';

import { CartCommandDto } from './cart-command.dto';

export class AddCartItemDto extends CartCommandDto {
  @IsUUID() recordUuid: string;
  @IsInt() @Min(1) @Max(2147483647) quantity: number;
}
