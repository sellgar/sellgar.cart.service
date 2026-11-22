import { Injectable } from '@nestjs/common';
import { OutboxWriter } from '@sellgar/outbox';
import { EntityManager } from 'typeorm';

import { CartRow } from '../../api/v1/cart/entity/cart-row.entity';

@Injectable()
export class CartEventsRepository {
  constructor(private readonly outbox: OutboxWriter) {}

  async changed(manager: EntityManager, cart: CartRow, type = 'cart.updated'): Promise<void> {
    await this.write(manager, type, 'cart', cart.uuid, cart.version, {
      cartUuid: cart.uuid,
      shopUuid: cart.shop_uuid,
      ownerUuid: cart.owner_uuid,
      version: cart.version,
    });
  }

  async write(
    manager: EntityManager,
    type: string,
    aggregateType: string,
    uuid: string,
    version: string | number,
    payload: object,
  ): Promise<void> {
    await this.outbox.add(manager, {
      eventType: type,
      aggregateType,
      aggregateId: uuid,
      aggregateVersion: version,
      payload: payload as Record<string, unknown>,
    });
  }
}
