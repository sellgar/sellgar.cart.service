import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { GetCartCheckoutDto } from '../controller/dto/get-cart-checkout.dto';
import { PreviewCartDto } from '../controller/dto/preview-cart.dto';
import { CartCheckoutEntity } from '../entity/cart-checkout.entity';
import { CartRow } from '../entity/cart-row.entity';
import { CartSelectionEntity } from '../entity/cart-selection.entity';
import { CartQueryRepository } from '../repository/cart-query.repository';
import { CartRepository } from '../repository/cart.repository';
import { CartSelectionFactory } from './cart-selection.factory';

@Injectable()
export class CartCheckoutQueryService {
  constructor(
    @InjectDataSource() private readonly source: DataSource,
    private readonly carts: CartRepository,
    private readonly queries: CartQueryRepository,
    private readonly selections: CartSelectionFactory,
  ) {}

  preview(input: PreviewCartDto): Promise<CartSelectionEntity> {
    return this.source.transaction('REPEATABLE READ', async (manager) => {
      await this.carts.assertOwnerOpen(manager, input.ownerUuid);
      const [cart]: CartRow[] = await manager.query(
        `SELECT * FROM carts WHERE uuid=$1 AND owner_uuid=$2 AND shop_uuid=$3 AND closed_at IS NULL`,
        [input.cartUuid, input.ownerUuid, input.shopUuid],
      );
      if (!cart) throw new NotFoundException('Cart not found');

      return this.selections.create(await this.queries.view(manager, cart), input);
    });
  }

  async get(input: GetCartCheckoutDto): Promise<CartCheckoutEntity> {
    const [checkout]: CartCheckoutEntity[] = await this.source.query(
      `SELECT ch.checkout_uuid AS "checkoutUuid",ch.cart_uuid AS "cartUuid",ch.status
      FROM cart_checkouts ch JOIN carts c ON c.uuid=ch.cart_uuid
      WHERE ch.checkout_uuid=$1 AND c.uuid=$2 AND c.owner_uuid=$3 AND c.shop_uuid=$4`,
      [input.checkoutUuid, input.cartUuid, input.ownerUuid, input.shopUuid],
    );
    if (!checkout) throw new NotFoundException('Checkout not found');
    return checkout;
  }
}
