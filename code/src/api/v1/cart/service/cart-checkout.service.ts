import { ConflictException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EntityManager } from 'typeorm';

import { lockOwner } from '../../../../common/database';
import { requestHash } from '../../../../common/request-hash';
import { CartEventsRepository } from '../../../../integration/outbox/cart-events.repository';
import { ProjectionRecoveryService } from '../../../../integration/recovery/projection-recovery.service';
import { CartCheckoutDto, PrepareCartDto } from '../controller/dto/cart.dto';
import { CartCommandRepository } from '../repository/cart-command.repository';
import { CartQueryRepository } from '../repository/cart-query.repository';
import { CartRepository } from '../repository/cart.repository';
import { cartItemView } from './cart-availability';

type CheckoutRow = {
  checkout_uuid: string;
  cart_uuid: string;
  status: 'prepared' | 'completed' | 'cancelled';
  request_hash: string | null;
};

@Injectable()
export class CartCheckoutService {
  constructor(
    private readonly commands: CartCommandRepository,
    private readonly carts: CartRepository,
    private readonly queries: CartQueryRepository,
    private readonly events: CartEventsRepository,
    private readonly config: ConfigService,
    private readonly recovery: ProjectionRecoveryService,
  ) {}

  prepare(input: PrepareCartDto) {
    const hash = requestHash({
      ownerUuid: input.ownerUuid,
      shopUuid: input.shopUuid,
      cartUuid: input.cartUuid,
      items: [...input.items].sort((a, b) => a.recordUuid.localeCompare(b.recordUuid)),
    });
    return this.commands.execute(
      'cart.checkout.prepare',
      input,
      async (manager) => {
        const cart = await this.carts.byUuid(manager, input, input.cartUuid, false);
        const existing = await this.existing(manager, input);
        if (existing) {
          if (existing.request_hash !== null && existing.request_hash !== hash)
            throw new ConflictException('Checkout preparation has different contents');
          return { checkoutUuid: input.checkoutUuid, cartUuid: cart.uuid, status: existing.status };
        }

        for (const item of input.items) {
          const [row] = await manager.query(
            'SELECT version::text,quantity,checkout_uuid FROM cart_items WHERE cart_uuid=$1 AND record_uuid=$2',
            [cart.uuid, item.recordUuid],
          );
          this.carts.assertItemVersion(row, item.expectedItemVersion);
          if (row.quantity !== item.quantity)
            throw new ConflictException('Checkout quantity differs from cart');
          await this.recovery.synchronize('record_inventory', item.recordUuid);
          const view = cartItemView(
            await this.queries.line(manager, cart, item.recordUuid),
            cart.shop_uuid,
            this.config.getOrThrow('CART_CURRENCY_CODE'),
          );
          if (!view.canCheckout)
            throw new ConflictException({ message: view.message, reasons: view.reasons });
        }

        await manager.query(
          "INSERT INTO cart_checkouts(checkout_uuid,cart_uuid,request_hash,status) VALUES ($1,$2,$3,'prepared')",
          [input.checkoutUuid, cart.uuid, hash],
        );
        const next = await this.carts.advance(manager, cart);
        await manager.query(
          'UPDATE cart_items SET checkout_uuid=$2,version=$3 WHERE cart_uuid=$1 AND record_uuid=ANY($4::uuid[])',
          [cart.uuid, input.checkoutUuid, next.version, input.items.map((i) => i.recordUuid)],
        );
        await this.events.changed(manager, next);
        return { checkoutUuid: input.checkoutUuid, cartUuid: cart.uuid, status: 'prepared' };
      },
      async (manager) => {
        await lockOwner(manager, input.ownerUuid);
        await this.carts.assertOwnerOpen(manager, input.ownerUuid);
      },
    );
  }

  complete(input: CartCheckoutDto) {
    return this.finish(input, 'completed');
  }

  cancel(input: CartCheckoutDto) {
    return this.finish(input, 'cancelled');
  }

  private finish(input: CartCheckoutDto, outcome: 'completed' | 'cancelled') {
    return this.commands.execute(
      `cart.checkout.${outcome}`,
      input,
      async (manager) => {
        const cart = await this.carts.byUuid(manager, input, input.cartUuid, true);
        const existing = await this.existing(manager, input);
        if (existing?.status === outcome)
          return { checkoutUuid: input.checkoutUuid, cartUuid: cart.uuid, status: outcome };
        if (existing && existing.status !== 'prepared')
          throw new ConflictException('Checkout has another terminal outcome');
        if (!existing && outcome === 'completed') throw new ConflictException('Checkout was not prepared');

        if (!existing) {
          // A cancellation tombstone prevents a delayed prepare from locking rows.
          await manager.query(
            "INSERT INTO cart_checkouts(checkout_uuid,cart_uuid,status,finished_at) VALUES ($1,$2,'cancelled',now())",
            [input.checkoutUuid, cart.uuid],
          );
        } else {
          const next = await this.carts.advance(manager, cart);
          if (outcome === 'completed') {
            await manager.query('DELETE FROM cart_items WHERE cart_uuid=$1 AND checkout_uuid=$2', [
              cart.uuid,
              input.checkoutUuid,
            ]);
          } else {
            await manager.query(
              'UPDATE cart_items SET checkout_uuid=NULL,version=$3 WHERE cart_uuid=$1 AND checkout_uuid=$2',
              [cart.uuid, input.checkoutUuid, next.version],
            );
          }
          await manager.query(
            'UPDATE cart_checkouts SET status=$2,finished_at=now() WHERE checkout_uuid=$1',
            [input.checkoutUuid, outcome],
          );
          await this.events.changed(manager, next);
        }
        return { checkoutUuid: input.checkoutUuid, cartUuid: cart.uuid, status: outcome };
      },
      (manager) => lockOwner(manager, input.ownerUuid),
    );
  }

  private async existing(manager: EntityManager, input: CartCheckoutDto): Promise<CheckoutRow | undefined> {
    const [row]: CheckoutRow[] = await manager.query('SELECT * FROM cart_checkouts WHERE checkout_uuid=$1', [
      input.checkoutUuid,
    ]);
    if (row && row.cart_uuid !== input.cartUuid)
      throw new ConflictException('Checkout belongs to another cart');
    return row;
  }
}
