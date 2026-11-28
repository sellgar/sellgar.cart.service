import { IsUUID } from 'class-validator';

import { PreviewCartDto } from './preview-cart.dto';

export class PrepareCartDto extends PreviewCartDto {
  @IsUUID() idempotencyKey: string;
  @IsUUID() checkoutUuid: string;
}
