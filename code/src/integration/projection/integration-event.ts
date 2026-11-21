import { BadRequestException } from '@nestjs/common';
import { IsInt, IsISO8601, IsObject, IsString, IsUUID, Min } from 'class-validator';

import { checked } from '../../common/checked';

import {
  InventoryPayloadDto,
  ProductPayloadDto,
  ShopPayloadDto,
  StorePayloadDto,
} from './source-payload.dto';

export type ProjectionKind = 'shop' | 'product' | 'store_product' | 'record_inventory';

export class IntegrationEvent {
  @IsUUID() eventUuid: string;
  @IsString() producer: string;
  @IsString() eventType: string;
  @IsString() aggregateType: ProjectionKind;
  @IsUUID() aggregateUuid: string;
  @IsInt() @Min(1) aggregateVersion: number;
  @IsInt() @Min(1) schemaVersion: number;
  @IsISO8601() occurredAt: string;
  @IsObject() payload: Record<string, unknown>;
}

export const sources = {
  shop: {
    producer: 'shop_srv',
    schemaVersion: 3,
    type: ShopPayloadDto,
    events: ['shop.created', 'shop.updated'],
  },
  product: {
    producer: 'product_srv',
    schemaVersion: 3,
    type: ProductPayloadDto,
    events: ['product.created', 'product.updated'],
  },
  store_product: {
    producer: 'store_srv',
    schemaVersion: 3,
    type: StorePayloadDto,
    events: ['store.product.created', 'store.product.updated', 'store.product.archived'],
  },
  record_inventory: {
    producer: 'store_srv',
    schemaVersion: 2,
    type: InventoryPayloadDto,
    events: ['store.inventory.updated'],
  },
} as const;

export async function integrationEvent(input: unknown): Promise<IntegrationEvent> {
  const raw = input as Record<string, unknown> | null;
  const event = await checked(IntegrationEvent, {
    ...raw,
    aggregateUuid: raw?.aggregateUuid ?? raw?.aggregateId,
  });
  const contract = sources[event.aggregateType];
  if (
    !contract ||
    contract.producer !== event.producer ||
    (contract.schemaVersion !== event.schemaVersion &&
      !(event.aggregateType === 'store_product' && event.schemaVersion === 2)) ||
    !(contract.events as readonly string[]).includes(event.eventType)
  )
    throw new BadRequestException('Unsupported source event contract');
  return event;
}
