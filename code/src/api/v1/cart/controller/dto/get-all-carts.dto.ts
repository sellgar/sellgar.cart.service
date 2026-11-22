import { CursorQueryDto } from '@sellgar/pagination';
import { IsIn, IsOptional, IsUUID } from 'class-validator';

export class GetAllCartsDto extends CursorQueryDto {
  @IsOptional() @IsUUID() shopUuid?: string;
  @IsOptional() @IsUUID() ownerUuid?: string;
  @IsOptional() @IsIn(['active', 'closed']) status?: 'active' | 'closed';
}

export class GetCartByUuidDto {
  @IsUUID() uuid: string;
}
