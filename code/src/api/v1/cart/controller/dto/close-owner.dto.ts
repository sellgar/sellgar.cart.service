import { IsUUID } from 'class-validator';

export class CloseOwnerDto {
  @IsUUID() idempotencyKey: string;
  @IsUUID() ownerUuid: string;
}
