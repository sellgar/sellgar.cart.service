import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EntityManager } from 'typeorm';

import { CartLineRow } from '../entity/cart-line-row.entity';
import { CartRow } from '../entity/cart-row.entity';
import { CartView } from '../entity/cart-view.entity';
import { cartItemView } from '../service/cart-availability';
import { sumPrices } from '../service/money';

@Injectable()
export class CartQueryRepository {
  constructor(private readonly config: ConfigService) {}

  async line(manager: EntityManager, cart: CartRow, recordUuid: string): Promise<CartLineRow> {
    return (await this.lines(manager, cart, [recordUuid]))[0];
  }

  async view(manager: EntityManager, cart: CartRow): Promise<CartView> {
    const records: { record_uuid: string }[] = await manager.query(
      'SELECT record_uuid FROM cart_items WHERE cart_uuid=$1 ORDER BY record_uuid',
      [cart.uuid],
    );
    const currencyCode = this.config.getOrThrow<string>('CART_CURRENCY_CODE');
    const raw = records.length
      ? await this.lines(
          manager,
          cart,
          records.map((r) => r.record_uuid),
        )
      : [];
    const items = raw.map((row) => cartItemView(row, cart.shop_uuid, currencyCode));
    const included = items.filter(
      (item) => !item.reasons.includes('not_sold') && !item.reasons.includes('hidden'),
    );
    const [shop] = await manager.query('SELECT name,source_version FROM shop_snapshot WHERE uuid=$1', [
      cart.shop_uuid,
    ]);

    return {
      uuid: cart.uuid,
      ownerUuid: cart.owner_uuid,
      version: cart.version,
      shop: { uuid: cart.shop_uuid, name: shop?.name ?? null, sourceVersion: shop?.source_version ?? null },
      items,
      currencyCode,
      itemsTotal: included.every((i) => i.price !== null && i.price.currencyCode === currencyCode)
        ? sumPrices(included.map((i) => i.subtotal!))
        : null,
    };
  }

  private lines(manager: EntityManager, cart: CartRow, records: string[]): Promise<CartLineRow[]> {
    return manager.query(
      `SELECT target.record_uuid,
      COALESCE(ci.quantity,1) AS quantity, COALESCE(ci.version,0)::text AS version, ci.checkout_uuid,
      ar.uuid IS NOT NULL AS record_exists, ar.article, ar.clarifications,
      o.uuid AS offer_uuid, sp.uuid AS store_product_uuid, sp.product_uuid, o.variant_uuid,
      p.name AS product_name, v.name AS variant_name, v.image_uuid,
      p.status AS product_status, v.status AS variant_status, sp.status AS store_product_status,
      o.status AS offer_status, sp.showing AS product_showing, o.showing AS offer_showing,
      ar.price_uuid, ar.price_value::text, ar.currency_code, inv.available,
      sp.shop_uuid, sh.name AS shop_name, sh.source_version AS shop_version,
      p.source_version AS product_version, sp.source_version AS store_version, inv.source_version AS inventory_version,
      EXISTS(SELECT 1 FROM sync_issue si JOIN inbox_event ie USING(event_uuid)
        WHERE si.resolved_at IS NULL AND (ie.aggregate_uuid IN (sp.uuid,sp.product_uuid,sp.shop_uuid)
          OR (ie.aggregate_type='record_inventory' AND ie.payload->>'recordUuid'=target.record_uuid::text))) AS sync_pending
      FROM unnest($1::uuid[]) target(record_uuid)
      LEFT JOIN cart_items ci ON ci.cart_uuid=$2 AND ci.record_uuid=target.record_uuid
      LEFT JOIN accounting_record_snapshot ar ON ar.uuid=target.record_uuid
      LEFT JOIN store_offer_snapshot o ON o.uuid=ar.offer_uuid
      LEFT JOIN store_product_snapshot sp ON sp.uuid=o.store_product_uuid
      LEFT JOIN shop_snapshot sh ON sh.uuid=sp.shop_uuid
      LEFT JOIN product_snapshot p ON p.uuid=sp.product_uuid
      LEFT JOIN variant_snapshot v ON v.uuid=o.variant_uuid AND v.product_uuid=sp.product_uuid
      LEFT JOIN record_inventory_snapshot inv ON inv.record_uuid=target.record_uuid
      ORDER BY target.record_uuid`,
      [records, cart.uuid],
    );
  }
}
