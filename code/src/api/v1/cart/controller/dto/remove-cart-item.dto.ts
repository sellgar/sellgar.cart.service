import { IsString, IsUUID, Matches } from 'class-validator';

import { CartCommandDto } from './cart-command.dto';

export class RemoveCartItemDto extends CartCommandDto {
  @IsUUID() recordUuid: string;
  @IsString() @Matches(/^[1-9]\d*$/) expectedItemVersion: string;
}
