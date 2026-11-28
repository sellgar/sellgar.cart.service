import { ConflictException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EntityManager } from 'typeorm';

import { lockOwner } from '../../../../common/database';
import { requestHash } from '../../../../common/request-hash';
import { CartEventsRepository } from '../../../../integration/outbox/cart-events.repository';
import { ProjectionRecoveryService } from '../../../../integration/recovery/projection-recovery.service';
import { CartCheckoutDto } from '../controller/dto/cart-checkout.dto';
import { PrepareCartDto } from '../controller/dto/prepare-cart.dto';
import { CartCheckoutEntity } from '../entity/cart-checkout.entity';
import { CartCheckoutRow } from '../entity/cart-checkout-row.entity';
import { CheckoutEvent } from '../enum/checkout-event.enum';
import { CheckoutStatus } from '../enum/checkout-status.enum';
import { CartCommandRepository } from '../repository/cart-command.repository';
import { CartQueryRepository } from '../repository/cart-query.repository';
import { CartRepository } from '../repository/cart.repository';
import { cartItemView } from './cart-availability';
import { CheckoutStateMachine } from './checkout-state-machine';

@Injectable()
export class CartCheckoutService {
  constructor(
    private readonly commands: CartCommandRepository,
    private readonly carts: CartRepository,
    private readonly queries: CartQueryRepository,
    private readonly events: CartEventsRepository,
    private readonly config: ConfigService,
    private readonly recovery: ProjectionRecoveryService,
    private readonly states: CheckoutStateMachine,
  ) {}

  prepare(input: PrepareCartDto): Promise<CartCheckoutEntity> {
    const hash = requestHash({
      ownerUuid: input.ownerUuid,
      shopUuid: input.shopUuid,
      cartUuid: input.cartUuid,
      items: [...input.items].sort((a, b) => a.recordUuid.localeCompare(b.recordUuid)),
    });
    return this.commands.execute<CartCheckoutEntity>(
      'cart.checkout.prepare',
      input,
      async (manager) => {
        const cart = await this.carts.byUuid(manager, input, input.cartUuid, false);
        const existing = await this.existing(manager, input);
        const status = this.states.transition(existing?.status ?? null, CheckoutEvent.PREPARE);
        if (existing) {
          if (existing.request_hash !== null && existing.request_hash !== hash)
            throw new ConflictException('Checkout preparation has different contents');
          return { checkoutUuid: input.checkoutUuid, cartUuid: cart.uuid, status };
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
          'INSERT INTO cart_checkouts(checkout_uuid,cart_uuid,request_hash,status) VALUES ($1,$2,$3,$4)',
          [input.checkoutUuid, cart.uuid, hash, status],
        );
        const next = await this.carts.advance(manager, cart);
        await manager.query(
          'UPDATE cart_items SET checkout_uuid=$2,version=$3 WHERE cart_uuid=$1 AND record_uuid=ANY($4::uuid[])',
          [cart.uuid, input.checkoutUuid, next.version, input.items.map((i) => i.recordUuid)],
        );
        await this.events.changed(manager, next);
        return { checkoutUuid: input.checkoutUuid, cartUuid: cart.uuid, status };
      },
      async (manager) => {
        await lockOwner(manager, input.ownerUuid);
        await this.carts.assertOwnerOpen(manager, input.ownerUuid);
      },
    );
  }

  complete(input: CartCheckoutDto) {
    return this.finish(input, CheckoutEvent.COMPLETE);
  }

  cancel(input: CartCheckoutDto) {
    return this.finish(input, CheckoutEvent.CANCEL);
  }

  private finish(input: CartCheckoutDto, event: CheckoutEvent.COMPLETE | CheckoutEvent.CANCEL) {
    const outcome = event === CheckoutEvent.COMPLETE ? CheckoutStatus.COMPLETED : CheckoutStatus.CANCELLED;
    return this.commands.execute<CartCheckoutEntity>(
      `cart.checkout.${outcome}`,
      input,
      async (manager) => {
        const cart = await this.carts.byUuid(manager, input, input.cartUuid, true);
        const existing = await this.existing(manager, input);
        this.states.transition(existing?.status ?? null, event);
        if (existing?.status === outcome)
          return { checkoutUuid: input.checkoutUuid, cartUuid: cart.uuid, status: outcome };

        if (!existing) {
          // A cancellation tombstone prevents a delayed prepare from locking rows.
          await manager.query(
            'INSERT INTO cart_checkouts(checkout_uuid,cart_uuid,status,finished_at) VALUES ($1,$2,$3,now())',
            [input.checkoutUuid, cart.uuid, outcome],
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

  private async existing(
    manager: EntityManager,
    input: Pick<CartCheckoutDto, 'checkoutUuid' | 'cartUuid'>,
  ): Promise<CartCheckoutRow | undefined> {
    const [row]: CartCheckoutRow[] = await manager.query(
      'SELECT * FROM cart_checkouts WHERE checkout_uuid=$1',
      [input.checkoutUuid],
    );
    if (row && row.cart_uuid !== input.cartUuid)
      throw new ConflictException('Checkout belongs to another cart');
    return row;
  }
}
