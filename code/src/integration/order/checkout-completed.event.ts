import { Transform, Type } from 'class-transformer';
import {
  Equals,
  IsDefined,
  IsISO8601,
  IsObject,
  IsString,
  IsUUID,
  Matches,
  ValidateNested,
} from 'class-validator';

import { CheckoutCompletedPayload } from './checkout-completed-payload';

export class CheckoutCompletedEvent {
  @IsUUID() eventUuid: string;
  @Equals('order_srv') producer: string;
  @Equals('order.checkout.completed') eventType: string;
  @Equals('checkout') aggregateType: string;
  @IsUUID() aggregateUuid: string;
  @Transform(({ value }) => (Number.isSafeInteger(value) ? String(value) : value))
  @IsString()
  @Matches(/^[1-9]\d*$/)
  aggregateVersion: string;
  @Equals(1) schemaVersion: number;
  @IsISO8601() occurredAt: string;
  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => CheckoutCompletedPayload)
  payload: CheckoutCompletedPayload;
}
