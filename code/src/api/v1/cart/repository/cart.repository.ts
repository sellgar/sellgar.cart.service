import {
  ConflictException,
  GoneException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { EntityManager } from 'typeorm';

import { rows } from '../../../../common/database';
import { CartEventsRepository } from '../../../../integration/outbox/cart-events.repository';
import { CartScopeDto } from '../controller/dto/cart-scope.dto';
import { CartRow } from '../entity/cart-row.entity';

@Injectable()
export class CartRepository {
  constructor(private readonly events: CartEventsRepository) {}

  async assertOwnerOpen(manager: EntityManager, ownerUuid: string): Promise<void> {
    const [closed] = await manager.query(
      `SELECT 1 FROM command_request WHERE command_type='cart.owner.close' AND result->>'ownerUuid'=$1 LIMIT 1`,
      [ownerUuid],
    );
    if (closed) throw new GoneException('Owner has been closed by Identity');
  }

  async current(manager: EntityManager, scope: CartScopeDto, create: boolean): Promise<CartRow> {
    await this.assertOwnerOpen(manager, scope.ownerUuid);
    const [existing]: CartRow[] = await manager.query(
      'SELECT * FROM carts WHERE owner_uuid=$1 AND shop_uuid=$2 AND closed_at IS NULL FOR UPDATE',
      [scope.ownerUuid, scope.shopUuid],
    );
    if (existing) return existing;
    if (!create) throw new NotFoundException('Cart not found');

    const [shop] = await manager.query('SELECT uuid FROM shop_snapshot WHERE uuid=$1', [scope.shopUuid]);
    if (!shop) throw new ServiceUnavailableException('Shop projection is not synchronized');
    // A transaction-scoped lock protects the previously absent owner/shop pair.
    await manager.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `cart-shop:${scope.ownerUuid}:${scope.shopUuid}`,
    ]);
    const [parallel]: CartRow[] = await manager.query(
      'SELECT * FROM carts WHERE owner_uuid=$1 AND shop_uuid=$2 AND closed_at IS NULL FOR UPDATE',
      [scope.ownerUuid, scope.shopUuid],
    );
    if (parallel) return parallel;

    const [cart]: CartRow[] = await manager.query(
      'INSERT INTO carts(uuid,owner_uuid,shop_uuid) VALUES ($1,$2,$3) RETURNING *',
      [randomUUID(), scope.ownerUuid, scope.shopUuid],
    );
    await this.events.changed(manager, cart, 'cart.created');
    return cart;
  }

  async byUuid(
    manager: EntityManager,
    scope: CartScopeDto,
    uuid: string,
    allowClosed: boolean,
  ): Promise<CartRow> {
    const [cart]: CartRow[] = await manager.query(
      'SELECT * FROM carts WHERE uuid=$1 AND owner_uuid=$2 AND shop_uuid=$3 FOR UPDATE',
      [uuid, scope.ownerUuid, scope.shopUuid],
    );
    if (!cart) throw new NotFoundException('Cart not found');
    if (!allowClosed) {
      await this.assertOwnerOpen(manager, scope.ownerUuid);
      if (cart.closed_at) throw new GoneException('Cart is closed');
    }
    return cart;
  }

  async advance(manager: EntityManager, cart: CartRow): Promise<CartRow> {
    const [next] = rows<CartRow>(
      await manager.query('UPDATE carts SET version=version+1,updated_at=now() WHERE uuid=$1 RETURNING *', [
        cart.uuid,
      ]),
    );
    return next;
  }

  assertItemVersion(
    row: { version: string; checkout_uuid: string | null } | undefined,
    expectedItemVersion: string,
  ): void {
    if (!row || row.version !== expectedItemVersion)
      throw new ConflictException('Cart item version conflict');
    if (row.checkout_uuid) throw new ConflictException('Cart item is being checked out');
  }
}
