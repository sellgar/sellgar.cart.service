import { IsUUID } from 'class-validator';

export class CartScopeDto {
  @IsUUID() ownerUuid: string;
  @IsUUID() shopUuid: string;
}
