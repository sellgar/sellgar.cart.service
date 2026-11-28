import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';

import { lockOwner, rows } from '../../../../common/database';
import { CartEventsRepository } from '../../../../integration/outbox/cart-events.repository';
import { SourceGateway } from '../../../../integration/recovery/source.gateway';
import { ProjectionRecoveryService } from '../../../../integration/recovery/projection-recovery.service';
import { AddCartItemDto } from '../controller/dto/add-cart-item.dto';
import { CartScopeDto } from '../controller/dto/cart-scope.dto';
import { CloseOwnerDto } from '../controller/dto/close-owner.dto';
import { RemoveCartItemDto } from '../controller/dto/remove-cart-item.dto';
import { SetCartItemDto } from '../controller/dto/set-cart-item.dto';
import { CartRow } from '../entity/cart-row.entity';
import { CartCommandRepository } from '../repository/cart-command.repository';
import { CartQueryRepository } from '../repository/cart-query.repository';
import { CartRepository } from '../repository/cart.repository';
import { cartItemView } from './cart-availability';

@Injectable()
export class CartService {
  constructor(
    @InjectDataSource() private readonly source: DataSource,
    private readonly commands: CartCommandRepository,
    private readonly carts: CartRepository,
    private readonly queries: CartQueryRepository,
    private readonly events: CartEventsRepository,
    private readonly store: SourceGateway,
    private readonly config: ConfigService,
    private readonly recovery: ProjectionRecoveryService,
  ) {}

  get(scope: CartScopeDto) {
    return this.source.transaction(async (manager) => {
      await lockOwner(manager, scope.ownerUuid);
      const cart = await this.carts.current(manager, scope, true);
      return this.queries.view(manager, cart);
    });
  }

  add(input: AddCartItemDto, cartUuid?: string) {
    const command = { ...input, cartUuid };
    return this.commands.execute(
      'cart.item.add',
      command,
      async (manager) => {
        const cart = await this.target(manager, input, cartUuid, true);
        const [current] = await manager.query(
          'SELECT quantity,checkout_uuid FROM cart_items WHERE cart_uuid=$1 AND record_uuid=$2',
          [cart.uuid, input.recordUuid],
        );
        if (current?.checkout_uuid) throw new ConflictException('Cart item is being checked out');
        const quantity = (current?.quantity ?? 0) + input.quantity;
        if (!Number.isSafeInteger(quantity) || quantity > 2147483647)
          throw new BadRequestException('Quantity exceeds integer range');
        await this.assertPurchasable(manager, cart, input.recordUuid, quantity);

        const next = await this.carts.advance(manager, cart);
        await manager.query(
          `INSERT INTO cart_items(cart_uuid,record_uuid,quantity,version) VALUES ($1,$2,$3,$4)
        ON CONFLICT(cart_uuid,record_uuid) DO UPDATE SET quantity=EXCLUDED.quantity,version=EXCLUDED.version`,
          [cart.uuid, input.recordUuid, quantity, next.version],
        );
        await this.events.changed(manager, next);
        return { cartUuid: cart.uuid, version: next.version, recordUuid: input.recordUuid, quantity };
      },
      (manager) => this.authorize(manager, input.ownerUuid),
    );
  }

  setQuantity(input: SetCartItemDto, cartUuid?: string) {
    const command = { ...input, cartUuid };
    return this.commands.execute(
      'cart.item.setQuantity',
      command,
      async (manager) => {
        const cart = await this.target(manager, input, cartUuid, false);
        const [item] = await manager.query(
          'SELECT version::text,checkout_uuid FROM cart_items WHERE cart_uuid=$1 AND record_uuid=$2',
          [cart.uuid, input.recordUuid],
        );
        this.carts.assertItemVersion(item, input.expectedItemVersion);
        await this.assertPurchasable(manager, cart, input.recordUuid, input.quantity);

        const next = await this.carts.advance(manager, cart);
        await manager.query(
          'UPDATE cart_items SET quantity=$3,version=$4 WHERE cart_uuid=$1 AND record_uuid=$2',
          [cart.uuid, input.recordUuid, input.quantity, next.version],
        );
        await this.events.changed(manager, next);
        return {
          cartUuid: cart.uuid,
          version: next.version,
          recordUuid: input.recordUuid,
          quantity: input.quantity,
        };
      },
      (manager) => this.authorize(manager, input.ownerUuid),
    );
  }

  remove(input: RemoveCartItemDto, cartUuid?: string) {
    const command = { ...input, cartUuid };
    return this.commands.execute(
      'cart.item.remove',
      command,
      async (manager) => {
        const cart = await this.target(manager, input, cartUuid, false);
        const [item] = await manager.query(
          'SELECT version::text,checkout_uuid FROM cart_items WHERE cart_uuid=$1 AND record_uuid=$2',
          [cart.uuid, input.recordUuid],
        );
        this.carts.assertItemVersion(item, input.expectedItemVersion);
        await manager.query('DELETE FROM cart_items WHERE cart_uuid=$1 AND record_uuid=$2', [
          cart.uuid,
          input.recordUuid,
        ]);

        const next = await this.carts.advance(manager, cart);
        await this.events.changed(manager, next);
        return { cartUuid: cart.uuid, version: next.version, recordUuid: input.recordUuid };
      },
      (manager) => this.authorize(manager, input.ownerUuid),
    );
  }

  closeOwner(input: CloseOwnerDto) {
    return this.commands.execute(
      'cart.owner.close',
      input,
      async (manager) => {
        const carts: CartRow[] = await manager.query(
          'SELECT * FROM carts WHERE owner_uuid=$1 AND closed_at IS NULL ORDER BY uuid FOR UPDATE',
          [input.ownerUuid],
        );
        for (const cart of carts) {
          const [closed] = rows<CartRow>(
            await manager.query(
              'UPDATE carts SET closed_at=now(),updated_at=now(),version=version+1 WHERE uuid=$1 RETURNING *',
              [cart.uuid],
            ),
          );
          await this.events.changed(manager, closed, 'cart.closed');
        }
        return { ownerUuid: input.ownerUuid, cartUuids: carts.map((cart) => cart.uuid) };
      },
      (manager) => lockOwner(manager, input.ownerUuid, true),
    );
  }

  private async authorize(manager: EntityManager, ownerUuid: string): Promise<void> {
    await lockOwner(manager, ownerUuid);
    await this.carts.assertOwnerOpen(manager, ownerUuid);
  }

  private target(manager: EntityManager, scope: CartScopeDto, uuid: string | undefined, create: boolean) {
    return uuid ? this.carts.byUuid(manager, scope, uuid, false) : this.carts.current(manager, scope, create);
  }

  private async assertPurchasable(
    manager: EntityManager,
    cart: CartRow,
    recordUuid: string,
    quantity: number,
  ): Promise<void> {
    // Recovery commits independently: a rejected command must not roll back an observed archive.
    await this.recovery.synchronize('record_inventory', recordUuid);
    const line = await this.queries.line(manager, cart, recordUuid);
    const view = cartItemView(
      { ...line, quantity },
      cart.shop_uuid,
      this.config.getOrThrow('CART_CURRENCY_CODE'),
    );
    if (!view.canCheckout) throw new ConflictException({ message: view.message, reasons: view.reasons });
    try {
      await this.store.assertStock(
        line.store_product_uuid!,
        line.offer_uuid!,
        recordUuid,
        cart.shop_uuid,
        quantity,
      );
    } catch (error) {
      if (error instanceof ConflictException) await this.recovery.synchronize('record_inventory', recordUuid);
      throw error;
    }
  }
}
