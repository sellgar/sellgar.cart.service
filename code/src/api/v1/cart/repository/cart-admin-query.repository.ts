import { CursorPagination } from '@sellgar/pagination';
import { Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { CartModel } from '../model/carts.model';
import { GetAllCartsDto } from '../controller/dto/get-all-carts.dto';
import { CartAdminMetadata } from '../entity/cart-admin-metadata.entity';
import { CartAdminPage } from '../entity/cart-admin-page.entity';
import { CartAdminView } from '../entity/cart-admin-view.entity';
import { CartRow } from '../entity/cart-row.entity';
import { CartQueryRepository } from './cart-query.repository';
import { CartScopeDto } from '../controller/dto/cart.dto';

@Injectable()
export class CartAdminQueryRepository {
  constructor(
    private readonly queries: CartQueryRepository,
    private readonly pagination: CursorPagination,
  ) {}

  async getAll(manager: EntityManager, query: GetAllCartsDto): Promise<CartAdminPage> {
    const builder = manager.createQueryBuilder(CartModel, 'cart');
    if (query.shopUuid) builder.andWhere('cart.shopUuid = :shopUuid', { shopUuid: query.shopUuid });
    if (query.ownerUuid) builder.andWhere('cart.ownerUuid = :ownerUuid', { ownerUuid: query.ownerUuid });
    if (query.status)
      builder.andWhere(query.status === 'active' ? 'cart.closedAt IS NULL' : 'cart.closedAt IS NOT NULL');
    const page = await this.pagination.read(builder, query, {
      scope: 'cart.cart.list',
      filters: { shopUuid: query.shopUuid, ownerUuid: query.ownerUuid, status: query.status },
      order: [
        { expression: 'cart.createdAt', direction: 'DESC', type: 'timestamptz' },
        { expression: 'cart.uuid', direction: 'ASC', type: 'uuid' },
      ],
    });
    const summaries: { uuid: string; shop_name: string | null; items_count: number }[] =
      page.items.length === 0
        ? []
        : await manager.query(
            `SELECT c.uuid, sh.name AS shop_name,
      (SELECT count(*)::int FROM cart_items ci WHERE ci.cart_uuid=c.uuid) AS items_count
      FROM carts c LEFT JOIN shop_snapshot sh ON sh.uuid=c.shop_uuid WHERE c.uuid = ANY($1::uuid[])`,
            [page.items.map((cart) => cart.uuid)],
          );
    const byUuid = new Map(summaries.map((row) => [row.uuid, row]));
    return {
      items: page.items.map((cart) => ({
        uuid: cart.uuid,
        ownerUuid: cart.ownerUuid,
        version: cart.version,
        shop: { uuid: cart.shopUuid, name: byUuid.get(cart.uuid)?.shop_name ?? null },
        itemsCount: byUuid.get(cart.uuid)?.items_count ?? 0,
        createdAt: cart.createdAt.toISOString(),
        updatedAt: cart.updatedAt.toISOString(),
        closedAt: cart.closedAt?.toISOString() ?? null,
      })),
      meta: page.meta,
    };
  }

  async getByUuid(manager: EntityManager, uuid: string): Promise<CartAdminView> {
    const [cart]: CartRow[] = await manager.query('SELECT * FROM carts WHERE uuid=$1', [uuid]);
    if (!cart) throw new NotFoundException('Cart not found');
    const view = await this.queries.view(manager, cart);
    if (cart.closed_at) {
      view.items = view.items.map((item) => ({
        ...item,
        canCheckout: false,
        canIncrease: false,
        canDecrease: false,
        canRemove: false,
      }));
    }
    return { ...view, ...this.metadata(cart) };
  }

  async scope(manager: EntityManager, uuid: string): Promise<CartScopeDto> {
    const [cart]: Pick<CartRow, 'owner_uuid' | 'shop_uuid'>[] = await manager.query(
      'SELECT owner_uuid,shop_uuid FROM carts WHERE uuid=$1',
      [uuid],
    );
    if (!cart) throw new NotFoundException('Cart not found');
    return { ownerUuid: cart.owner_uuid, shopUuid: cart.shop_uuid };
  }

  private metadata(row: CartRow): CartAdminMetadata {
    return {
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
      closedAt: row.closed_at?.toISOString() ?? null,
    };
  }
}
