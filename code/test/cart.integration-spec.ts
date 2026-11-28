import 'reflect-metadata';

import { CursorPagination } from '@sellgar/pagination';
import { OutboxWriter } from '@sellgar/outbox';
import { ConfigService } from '@nestjs/config';
import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { randomUUID } from 'node:crypto';
import { ConflictException, Logger } from '@nestjs/common';
import { RmqContext } from '@nestjs/microservices';
import { DataSource } from 'typeorm';
import { OutboxRepository } from '@sellgar/outbox';

import { CART_OUTBOX_OPTIONS } from '../src/integration/outbox/cart-outbox.options';
import { CartDatabaseOptions } from '../src/database/cart-database.options';
import { CartCommandRepository } from '../src/api/v1/cart/repository/cart-command.repository';
import { CartRepository } from '../src/api/v1/cart/repository/cart.repository';
import { CartQueryRepository } from '../src/api/v1/cart/repository/cart-query.repository';
import { CartService } from '../src/api/v1/cart/service/cart.service';
import { CartCheckoutService } from '../src/api/v1/cart/service/cart-checkout.service';
import { CartCheckoutQueryService } from '../src/api/v1/cart/service/cart-checkout-query.service';
import { CartSelectionFactory } from '../src/api/v1/cart/service/cart-selection.factory';
import { CheckoutStateMachine } from '../src/api/v1/cart/service/checkout-state-machine';
import { CartAdminService } from '../src/api/v1/cart/service/cart-admin.service';
import { CartAdminQueryRepository } from '../src/api/v1/cart/repository/cart-admin-query.repository';
import { GetAllCartsDto } from '../src/api/v1/cart/controller/dto/get-all-carts.dto';
import { CartEventsRepository } from '../src/integration/outbox/cart-events.repository';
import { ProjectionService } from '../src/integration/projection/projection.service';
import { ProjectionRecoveryService } from '../src/integration/recovery/projection-recovery.service';
import { SourceGateway } from '../src/integration/recovery/source.gateway';
import { OrderEventsController } from '../src/integration/order/order-events.controller';

if (existsSync('.env')) {
  for (const [key, value] of Object.entries(parseEnv(readFileSync('.env', 'utf8')))) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

describe('Cart PostgreSQL invariants', () => {
  const schema = `cart_test_${randomUUID().replace(/-/g, '')}`;
  let db: DataSource;
  let carts: CartService;
  let checkouts: CartCheckoutService;
  let checkoutQueries: CartCheckoutQueryService;
  let admin: CartAdminService;
  let projections: ProjectionService;
  let events: CartEventsRepository;
  let config: ConfigService;
  let recovery: ProjectionRecoveryService;
  let fixture: ReturnType<typeof data>;
  const stock = { assertStock: jest.fn(async () => {}) };
  const scope = () => ({ ownerUuid: fixture.ownerUuid, shopUuid: fixture.shopUuid });
  const add = (quantity = 1, recordUuid = fixture.recordUuid, ownerUuid = fixture.ownerUuid) =>
    carts.add({ ...scope(), ownerUuid, recordUuid, quantity, idempotencyKey: randomUUID() });
  const view = () => carts.get(scope());
  const event = (kind: string, payload: any, version = payload.version) => ({
    eventUuid: randomUUID(),
    producer: kind === 'product' ? 'product_srv' : kind === 'shop' ? 'shop_srv' : 'store_srv',
    schemaVersion: kind === 'record_inventory' ? 2 : 3,
    aggregateType: kind,
    aggregateUuid: payload.uuid,
    aggregateVersion: version,
    eventType:
      kind === 'store_product'
        ? 'store.product.updated'
        : kind === 'record_inventory'
          ? 'store.inventory.updated'
          : `${kind}.updated`,
    occurredAt: new Date().toISOString(),
    payload,
  });

  function data() {
    const ownerUuid = randomUUID(),
      shopUuid = randomUUID(),
      productUuid = randomUUID(),
      variantUuid = randomUUID(),
      storeUuid = randomUUID(),
      offerUuid = randomUUID(),
      recordUuid = randomUUID(),
      secondRecordUuid = randomUUID();
    const inventoryUuid = randomUUID(),
      secondInventoryUuid = randomUUID(),
      priceUuid = randomUUID(),
      imageUuid = randomUUID();
    const shop = { uuid: shopUuid, version: 1, name: 'Центр' };
    const product = {
      uuid: productUuid,
      version: 1,
      name: 'Кофе',
      status: 'active',
      variants: [
        { uuid: variantUuid, name: 'Арабика', status: 'active', images: [{ imageUuid, sortOrder: 0 }] },
      ],
    };
    const record = (uuid: string, inventory: string) => ({
      uuid,
      offerUuid,
      article: `SKU-${uuid}`,
      currentPrice: { uuid: priceUuid, recordUuid: uuid, value: '125.50', currencyCode: 'RUB' },
      clarifications: [{ position: 0, value: '250 г' }],
      inventory: { uuid: inventory, recordUuid: uuid, version: 1, quantity: 10, reserved: 2 },
    });
    const store = {
      uuid: storeUuid,
      shopUuid,
      productUuid,
      version: 1,
      status: 'active',
      showing: true,
      offers: [
        {
          uuid: offerUuid,
          storeProductUuid: storeUuid,
          productUuid,
          variantUuid,
          status: 'active',
          showing: true,
          records: [record(recordUuid, inventoryUuid), record(secondRecordUuid, secondInventoryUuid)],
        },
      ],
    };
    return {
      ownerUuid,
      shopUuid,
      productUuid,
      variantUuid,
      storeUuid,
      offerUuid,
      recordUuid,
      secondRecordUuid,
      inventoryUuid,
      priceUuid,
      imageUuid,
      shop,
      product,
      store,
    };
  }

  beforeAll(async () => {
    const control = await new DataSource({
      ...CartDatabaseOptions.create(process.env),
      entities: [],
      migrations: [],
    }).initialize();
    try {
      await control.query(`CREATE SCHEMA "${schema}"`);
    } finally {
      await control.destroy();
    }
    db = await new DataSource(
      CartDatabaseOptions.create({ ...process.env, CART_DATABASE_SCHEMA: schema }),
    ).initialize();
    await db.runMigrations();
    config = new ConfigService({ CART_CURRENCY_CODE: 'RUB' });
    events = new CartEventsRepository(new OutboxWriter(CART_OUTBOX_OPTIONS));
    const commands = new CartCommandRepository(db),
      repository = new CartRepository(events),
      query = new CartQueryRepository(config);
    projections = new ProjectionService(db, events);
    recovery = new ProjectionRecoveryService(
      db,
      {
        storeProductByRecord: async () => fixture.store,
        shopByUuid: async () => fixture.shop,
        catalogProduct: async () => fixture.product,
      } as unknown as SourceGateway,
      projections,
      config,
    );
    carts = new CartService(
      db,
      commands,
      repository,
      query,
      events,
      stock as unknown as SourceGateway,
      config,
      recovery,
    );
    checkouts = new CartCheckoutService(
      commands,
      repository,
      query,
      events,
      config,
      recovery,
      new CheckoutStateMachine(),
    );
    checkoutQueries = new CartCheckoutQueryService(db, repository, query, new CartSelectionFactory());
    admin = new CartAdminService(
      db,
      new CartAdminQueryRepository(query, new CursorPagination('test-pagination-key-at-least-32-bytes')),
      carts,
    );
  });

  beforeEach(async () => {
    fixture = data();
    stock.assertStock.mockReset().mockResolvedValue(undefined);
    await projections.synchronize('shop', fixture.shop);
    await projections.synchronize('product', fixture.product);
    await projections.synchronize('store_product', fixture.store);
  });

  afterAll(async () => {
    if (db?.isInitialized) {
      await db.query(`DROP SCHEMA "${schema}" CASCADE`);
      await db.destroy();
    }
  });

  it('migrates exactly the 14 agreed tables and no owner discriminator', async () => {
    const tables = await db.query('SELECT tablename FROM pg_tables WHERE schemaname=$1', [schema]);
    expect(tables.filter((t: any) => t.tablename !== 'migrations')).toHaveLength(14);
    const columns = await db.query(
      "SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name='carts'",
      [schema],
    );
    expect(columns.map((c: any) => c.column_name).sort()).toEqual(
      ['uuid', 'shop_uuid', 'owner_uuid', 'version', 'created_at', 'updated_at', 'closed_at'].sort(),
    );
  });

  it('rejects a partially populated price at the database boundary', async () => {
    await expect(
      db.query('UPDATE accounting_record_snapshot SET price_value=NULL WHERE uuid=$1', [fixture.recordUuid]),
    ).rejects.toThrow('accounting_record_snapshot_price_ck');
  });

  it('creates one cart on concurrent first access, isolated by owner and shop', async () => {
    const [a, b] = await Promise.all([view(), view()]);
    expect(a.uuid).toBe(b.uuid);
    const other = await carts.get({ ...scope(), ownerUuid: randomUUID() });
    expect(other.uuid).not.toBe(a.uuid);
    const shop = randomUUID();
    await projections.synchronize('shop', { uuid: shop, version: 1, name: 'Север' });
    expect((await carts.get({ ...scope(), shopUuid: shop })).uuid).not.toBe(a.uuid);
  });

  it('renders names, clarification, image, decimal price and available stock locally', async () => {
    await add(2);
    const result = await view();
    expect(result.shop.name).toBe('Центр');
    expect(result.itemsTotal).toBe('251.00');
    expect(result.items[0]).toMatchObject({
      productName: 'Кофе',
      variantName: 'Арабика',
      article: `SKU-${fixture.recordUuid}`,
      clarifications: ['250 г'],
      imageUuid: fixture.imageUuid,
      available: 8,
      quantity: 2,
      canCheckout: true,
    });
    expect(stock.assertStock).toHaveBeenCalledTimes(1);
    await view();
    expect(stock.assertStock).toHaveBeenCalledTimes(1);
  });

  it('deduplicates concurrent add commands and rejects changing their owner or contents', async () => {
    const command = { ...scope(), idempotencyKey: randomUUID(), recordUuid: fixture.recordUuid, quantity: 2 };
    await Promise.all([carts.add(command), carts.add(command)]);
    expect((await view()).items[0].quantity).toBe(2);
    await expect(carts.add({ ...command, quantity: 3 })).rejects.toThrow('another request');
    await expect(carts.add({ ...command, ownerUuid: randomUUID() })).rejects.toThrow('another request');
  });

  it('serializes different increments and caps authoritative stock with atomic rollback', async () => {
    await Promise.all([add(2), add(3)]);
    expect((await view()).items[0].quantity).toBe(5);
    await expect(add(4)).rejects.toThrow();
    expect((await view()).items[0].quantity).toBe(5);
    const before = (await view()).version;
    stock.assertStock.mockRejectedValueOnce(new Error('Store unavailable'));
    await expect(add()).rejects.toThrow('Store unavailable');
    expect((await view()).version).toBe(before);
  });

  it('rejects a foreign-shop record without modifying the cart', async () => {
    const second = data();
    await projections.synchronize('shop', second.shop);
    await projections.synchronize('product', second.product);
    await projections.synchronize('store_product', second.store);
    await expect(add(1, second.recordUuid)).rejects.toThrow();
    expect((await view()).items).toEqual([]);
  });

  it('checks item versions, preserves unrelated versions and prevents delete/readd ABA', async () => {
    await add();
    const old = (await view()).items[0];
    await add(1, fixture.secondRecordUuid);
    await carts.remove({
      ...scope(),
      recordUuid: old.recordUuid,
      expectedItemVersion: old.version,
      idempotencyKey: randomUUID(),
    });
    await add();
    const current = (await view()).items.find((i) => i.recordUuid === old.recordUuid)!;
    expect(BigInt(current.version)).toBeGreaterThan(BigInt(old.version));
    await expect(
      carts.remove({
        ...scope(),
        recordUuid: old.recordUuid,
        expectedItemVersion: old.version,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toThrow('version conflict');
  });

  it('retains hidden and archived rows with exact agreed labels and priority', async () => {
    await add(2);
    fixture.store.version = 2;
    fixture.store.showing = false;
    await projections.apply(event('store_product', fixture.store));
    expect((await view()).items[0]).toMatchObject({
      message: 'Временно недоступен',
      quantity: 2,
      canCheckout: false,
      canRemove: true,
    });
    await expect(add()).rejects.toThrow();
    fixture.store.version = 3;
    fixture.store.status = 'archived';
    await projections.apply(event('store_product', fixture.store));
    const item = (await view()).items[0];
    expect(item.message).toBe('Товар больше не продается');
    fixture.store.version = 4;
    fixture.store.showing = true;
    await projections.apply(event('store_product', fixture.store));
    expect((await view()).items[0].canCheckout).toBe(false);
    await carts.remove({
      ...scope(),
      recordUuid: item.recordUuid,
      expectedItemVersion: item.version,
      idempotencyKey: randomUUID(),
    });
    expect((await view()).items).toEqual([]);
  });

  it('rejects a stale-page add and retains an unavailable row before the catalog event arrives', async () => {
    await add(2);
    const before = await view();
    fixture.product.version = 2;
    fixture.product.status = 'archived';
    // The owner changed, but its event has deliberately not been applied to Cart.
    expect((await view()).items[0].canCheckout).toBe(true);
    await expect(add()).rejects.toThrow('Товар больше не продается');
    const after = await view();
    expect(after.version).toBe(before.version);
    expect(after.items[0]).toMatchObject({
      quantity: 2,
      message: 'Товар больше не продается',
      canCheckout: false,
      canRemove: true,
    });
    expect(after.itemsTotal).toBe('0.00');
    const [projection] = await db.query('SELECT status,source_version FROM product_snapshot WHERE uuid=$1', [
      fixture.productUuid,
    ]);
    expect(projection).toEqual({ status: 'archived', source_version: 2 });
    await projections.apply(event('product', { ...fixture.product, version: 1, status: 'active' }));
    expect((await view()).items[0].canCheckout).toBe(false);
  });

  it('rejects a new archived variant without inserting a cart item', async () => {
    fixture.product.version = 2;
    fixture.product.variants[0].status = 'archived';
    await expect(add()).rejects.toThrow('Товар больше не продается');
    expect((await view()).items).toEqual([]);
  });

  it('refreshes a sale archived between recovery and the final Store check', async () => {
    await add(2);
    stock.assertStock.mockImplementationOnce(async () => {
      fixture.store.version = 2;
      fixture.store.status = 'archived';
      throw new ConflictException('Store no longer confirms this sellable record');
    });
    await expect(add()).rejects.toThrow('sellable record');
    const result = await view();
    expect(result.items[0]).toMatchObject({
      quantity: 2,
      message: 'Товар больше не продается',
      canCheckout: false,
    });
    expect(result.itemsTotal).toBe('0.00');
  });

  it('checks authoritative archive before checkout and keeps rows unlocked on rejection', async () => {
    await add(2);
    const item = (await view()).items[0];
    fixture.product.version = 2;
    fixture.product.variants[0].status = 'archived';
    await expect(
      checkouts.prepare({
        ...scope(),
        cartUuid: (await view()).uuid,
        checkoutUuid: randomUUID(),
        idempotencyKey: randomUUID(),
        items: [{ recordUuid: item.recordUuid, quantity: 2, expectedItemVersion: item.version }],
      }),
    ).rejects.toThrow('Товар больше не продается');
    expect((await view()).items[0]).toMatchObject({
      message: 'Товар больше не продается',
      checkoutUuid: null,
      canRemove: true,
    });
    expect((await view()).itemsTotal).toBe('0.00');
  });

  it('updates catalog names/status/images without a Store event or cart version change', async () => {
    await add();
    const before = await view();
    fixture.product.version = 2;
    fixture.product.name = 'Новое имя';
    fixture.product.variants[0].images = [];
    await projections.apply(event('product', fixture.product));
    const after = await view();
    expect(after.version).toBe(before.version);
    expect(after.items[0]).toMatchObject({ productName: 'Новое имя', imageUuid: null, canCheckout: true });
    fixture.product.version = 3;
    fixture.product.variants[0].status = 'archived';
    await projections.apply(event('product', fixture.product));
    expect((await view()).items[0].message).toBe('Товар больше не продается');
  });

  it('retains depleted/deficient quantities and does not confuse zero price with absent price', async () => {
    await add(4);
    const inventory = {
      ...fixture.store.offers[0].records[0].inventory,
      version: 2,
      quantity: 3,
      reserved: 2,
    };
    await projections.apply(event('record_inventory', inventory));
    let item = (await view()).items[0];
    expect(item).toMatchObject({ quantity: 4, available: 1, message: 'Выбранное количество недоступно' });
    inventory.version = 3;
    inventory.quantity = 2;
    await projections.apply(event('record_inventory', inventory));
    expect((await view()).items[0].message).toBe('Нет в наличии');
    fixture.store.version = 2;
    fixture.store.offers[0].records[0].currentPrice.value = '0.00';
    await projections.apply(event('store_product', fixture.store));
    expect((await view()).items[0].price?.value).toBe('0.00');
    const noPrice = JSON.parse(JSON.stringify(fixture.store));
    noPrice.version = 3;
    noPrice.offers[0].records[0].currentPrice = null;
    await projections.apply(event('store_product', noPrice));
    item = (await view()).items[0];
    expect(item.reasons).toContain('price_missing');
    expect((await view()).itemsTotal).toBeNull();
  });

  it('keeps different prices and reprices only the changed accounting record', async () => {
    await add(2);
    await add(1, fixture.secondRecordUuid);
    fixture.store.version++;
    fixture.store.offers[0].records[1].currentPrice = {
      uuid: randomUUID(),
      recordUuid: fixture.secondRecordUuid,
      value: '300.00',
      currencyCode: 'RUB',
    };
    const incoming = event('store_product', fixture.store);
    expect(await projections.apply(incoming)).toBe('processed');
    expect(await projections.apply(incoming)).toBe('ignored');
    let cart = await view();
    expect(cart.items.find((item) => item.recordUuid === fixture.recordUuid)?.price?.value).toBe('125.50');
    expect(cart.items.find((item) => item.recordUuid === fixture.secondRecordUuid)?.price?.value).toBe(
      '300.00',
    );
    expect(cart.itemsTotal).toBe('551.00');
    fixture.store.offers[0].records[1].currentPrice.uuid = randomUUID();
    await projections.synchronize('store_product', fixture.store);
    cart = await view();
    expect(cart.items.find((item) => item.recordUuid === fixture.secondRecordUuid)?.price?.uuid).toBe(
      fixture.store.offers[0].records[1].currentPrice.uuid,
    );
    const [before] = await db.query('SELECT count(*)::int AS count FROM outbox_event');
    await projections.synchronize('store_product', fixture.store);
    const [after] = await db.query('SELECT count(*)::int AS count FROM outbox_event');
    expect(after.count).toBe(before.count);
    const stale = structuredClone(fixture.store);
    stale.version--;
    stale.offers[0].records[1].currentPrice.value = '1.00';
    await projections.synchronize('store_product', stale);
    expect((await view()).itemsTotal).toBe('551.00');
  });

  it('accepts queued legacy Store events and then record-priced snapshots', async () => {
    const legacy = structuredClone(fixture.store) as any;
    legacy.version++;
    legacy.offers[0].currentPrice = {
      ...legacy.offers[0].records[0].currentPrice,
      offerUuid: fixture.offerUuid,
    };
    for (const record of legacy.offers[0].records) delete record.currentPrice;
    await projections.apply({ ...event('store_product', legacy), schemaVersion: 2 });
    await add();
    expect((await view()).items[0].price?.value).toBe('125.50');
    fixture.store.version = legacy.version + 1;
    fixture.store.offers[0].records[0].currentPrice.value = '200.00';
    await projections.apply(event('store_product', fixture.store));
    expect((await view()).items[0].price?.value).toBe('200.00');
  });

  it('never rolls inventory back from a newer store-product event', async () => {
    await add();
    const inventory = {
      ...fixture.store.offers[0].records[0].inventory,
      version: 2,
      quantity: 7,
      reserved: 2,
    };
    await projections.apply(event('record_inventory', inventory));
    fixture.store.version = 2;
    fixture.store.offers[0].records[0].currentPrice.value = '130.00';
    await projections.apply(event('store_product', fixture.store));
    expect((await view()).items[0]).toMatchObject({ available: 5, price: { value: '130.00' } });
    await projections.synchronize('store_product', {
      ...fixture.store,
      offers: [
        {
          ...fixture.store.offers[0],
          records: [
            { ...fixture.store.offers[0].records[0], inventory: { ...inventory, version: 3, quantity: 6 } },
            fixture.store.offers[0].records[1],
          ],
        },
      ],
    });
    expect((await view()).items[0].available).toBe(4);
  });

  it('parks gaps and restores from an authoritative snapshot, ignoring delayed events', async () => {
    await add();
    const changed = { ...fixture.product, version: 3, name: 'Версия 3' };
    const incoming = event('product', changed);
    expect(await projections.apply(incoming)).toBe('parked');
    expect((await view()).items[0].reasons).toContain('sync_pending');
    await projections.synchronize('product', changed);
    expect((await view()).items[0].productName).toBe('Версия 3');
    expect((await view()).items[0].reasons).not.toContain('sync_pending');
    expect(await projections.apply(incoming)).toBe('ignored');
    expect(
      await projections.apply(event('product', { ...fixture.product, version: 2, name: 'Старая' })),
    ).toBe('ignored');
    expect((await view()).items[0].productName).toBe('Версия 3');
  });

  it('recovers an inventory event arriving before its record parent', async () => {
    const missing = data();
    const inventory = { ...missing.store.offers[0].records[0].inventory, version: 2 };
    expect(await projections.apply(event('record_inventory', inventory))).toBe('parked');
    missing.store.offers[0].records[0].inventory = inventory;
    const gateway = {
      storeProductByRecord: jest.fn(async () => missing.store),
      shopByUuid: jest.fn(async () => missing.shop),
      catalogProduct: jest.fn(async () => missing.product),
    };
    const recovery = new ProjectionRecoveryService(
      db,
      gateway as unknown as SourceGateway,
      projections,
      config,
    );
    await recovery.recover();
    expect(gateway.storeProductByRecord).toHaveBeenCalledWith(missing.recordUuid);
    const [record] = await db.query('SELECT available FROM record_inventory_snapshot WHERE record_uuid=$1', [
      missing.recordUuid,
    ]);
    expect(record.available).toBe(8);
  });

  it('atomically rejects malformed snapshots and wrong producer/schema', async () => {
    const before = (await db.query('SELECT count(*)::int n FROM inbox_event'))[0].n;
    const malformed = JSON.parse(JSON.stringify(fixture.store));
    malformed.version = 2;
    malformed.offers[0].records[0].inventory.reserved = 50;
    await expect(projections.apply(event('store_product', malformed))).rejects.toThrow('Invalid inventory');
    await expect(
      projections.apply({ ...event('product', fixture.product), producer: 'legacy_product' }),
    ).rejects.toThrow('Unsupported');
    expect((await db.query('SELECT count(*)::int n FROM inbox_event'))[0].n).toBe(before);
  });

  it('calculates only selected lines without locking or changing the cart', async () => {
    await add(2);
    await add(3, fixture.secondRecordUuid);
    const cart = await view();
    const item = cart.items.find((line) => line.recordUuid === fixture.recordUuid)!;
    const before = await db.query('SELECT count(*)::int n FROM outbox_event');
    const result = await checkoutQueries.preview({
      ...scope(),
      cartUuid: cart.uuid,
      items: [{ recordUuid: item.recordUuid, quantity: 2, expectedItemVersion: item.version }],
    });
    expect(result).toMatchObject({
      cartUuid: cart.uuid,
      ownerUuid: fixture.ownerUuid,
      shop: { uuid: fixture.shopUuid, name: 'Центр' },
      currencyCode: 'RUB',
      itemsTotal: '251.00',
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      recordUuid: item.recordUuid,
      productName: 'Кофе',
      variantName: 'Арабика',
      article: item.article,
      clarifications: ['250 г'],
      imageUuid: fixture.imageUuid,
      quantity: 2,
      expectedItemVersion: item.version,
      unitPrice: { uuid: fixture.priceUuid, value: '125.50', currencyCode: 'RUB' },
      subtotal: '251.00',
    });
    expect(await view()).toEqual(cart);
    expect(await db.query('SELECT count(*)::int n FROM outbox_event')).toEqual(before);
    expect(
      (await db.query('SELECT count(*)::int n FROM cart_checkouts WHERE cart_uuid=$1', [cart.uuid]))[0].n,
    ).toBe(0);
    await add();
    expect((await view()).items.find((line) => line.recordUuid === item.recordUuid)?.quantity).toBe(3);
  });

  it('reads cart lines and prices from a single database snapshot', async () => {
    await add();
    const cart = await view();
    const item = cart.items[0];
    const queries = new CartQueryRepository(config);
    const read = queries.view.bind(queries);
    jest.spyOn(queries, 'view').mockImplementation(async (manager, row) => {
      await db.query('UPDATE accounting_record_snapshot SET price_value=200 WHERE uuid=$1', [
        item.recordUuid,
      ]);
      return read(manager, row);
    });
    const reader = new CartCheckoutQueryService(
      db,
      new CartRepository(events),
      queries,
      new CartSelectionFactory(),
    );
    const result = await reader.preview({
      ...scope(),
      cartUuid: cart.uuid,
      items: [{ recordUuid: item.recordUuid, quantity: 1, expectedItemVersion: item.version }],
    });
    expect(result.itemsTotal).toBe('125.50');
    expect((await view()).items[0].price?.value).toBe('200.00');
  });

  it('does not substitute a later price into the result already returned to Order', async () => {
    await add(2);
    const cart = await view(),
      item = cart.items[0];
    const selection = {
      ...scope(),
      cartUuid: cart.uuid,
      items: [{ recordUuid: item.recordUuid, quantity: 2, expectedItemVersion: item.version }],
    };
    const calculation = await checkoutQueries.preview(selection);
    fixture.store.version++;
    fixture.store.offers[0].records[0].currentPrice.value = '300.00';
    await projections.synchronize('store_product', fixture.store);
    expect((await view()).items[0].version).toBe(item.version);
    expect((await checkoutQueries.preview(selection)).itemsTotal).toBe('600.00');
    const prepared = await checkouts.prepare({
      ...selection,
      checkoutUuid: randomUUID(),
      idempotencyKey: randomUUID(),
    });
    expect(prepared.status).toBe('prepared');
    expect(prepared).not.toHaveProperty('itemsTotal');
    expect(calculation.items[0].unitPrice.value).toBe('125.50');
    expect(calculation.itemsTotal).toBe('251.00');
  });

  it('rejects stale, absent and incomplete selections without preparing any line', async () => {
    await add(2);
    const cart = await view(),
      item = cart.items[0];
    const base = { ...scope(), cartUuid: cart.uuid };
    const selected = { recordUuid: item.recordUuid, quantity: 2, expectedItemVersion: item.version };
    for (const change of [{ quantity: 1 }, { expectedItemVersion: '999' }, { recordUuid: randomUUID() }]) {
      await expect(checkoutQueries.preview({ ...base, items: [{ ...selected, ...change }] })).rejects.toThrow(
        'differs',
      );
    }
    await expect(checkoutQueries.preview({ ...base, items: [] })).rejects.toThrow('nonempty');
    await expect(checkoutQueries.preview({ ...base, items: [selected, selected] })).rejects.toThrow('unique');
    expect(await view()).toEqual(cart);
  });

  it('keeps preview scoped to the owner, shop and active cart', async () => {
    await add();
    const cart = await view(),
      item = cart.items[0];
    const input = {
      ...scope(),
      cartUuid: cart.uuid,
      items: [{ recordUuid: item.recordUuid, quantity: 1, expectedItemVersion: item.version }],
    };
    await expect(checkoutQueries.preview({ ...input, ownerUuid: randomUUID() })).rejects.toThrow('not found');
    await expect(checkoutQueries.preview({ ...input, shopUuid: randomUUID() })).rejects.toThrow('not found');
    await carts.closeOwner({ ownerUuid: fixture.ownerUuid, idempotencyKey: randomUUID() });
    await expect(checkoutQueries.preview(input)).rejects.toThrow('closed');
  });

  it('rejects archived or already prepared lines in preview', async () => {
    await add();
    const cart = await view(),
      item = cart.items[0];
    const input = {
      ...scope(),
      cartUuid: cart.uuid,
      items: [{ recordUuid: item.recordUuid, quantity: 1, expectedItemVersion: item.version }],
    };
    fixture.product.version++;
    fixture.product.status = 'archived';
    await projections.synchronize('product', fixture.product);
    await expect(checkoutQueries.preview(input)).rejects.toThrow('больше не продается');
    fixture.product.version++;
    fixture.product.status = 'active';
    await projections.synchronize('product', fixture.product);
    await checkouts.prepare({ ...input, checkoutUuid: randomUUID(), idempotencyKey: randomUUID() });
    const updated = (await view()).items[0];
    await expect(
      checkoutQueries.preview({
        ...input,
        items: [{ ...input.items[0], expectedItemVersion: updated.version }],
      }),
    ).rejects.toThrow('Оформляется');
  });

  it('recovers current checkout state after completion and owner closure', async () => {
    await add();
    const cart = await view(),
      item = cart.items[0];
    const base = { ...scope(), cartUuid: cart.uuid, checkoutUuid: randomUUID() };
    await expect(checkoutQueries.get(base)).rejects.toThrow('not found');
    const command = {
      ...base,
      idempotencyKey: randomUUID(),
      items: [{ recordUuid: item.recordUuid, quantity: 1, expectedItemVersion: item.version }],
    };
    const receipt = await checkouts.prepare(command);
    expect(await checkoutQueries.get(base)).toEqual(receipt);
    await checkouts.complete({ ...base, idempotencyKey: randomUUID() });
    expect(await checkouts.prepare(command)).toEqual(receipt);
    expect((await checkouts.prepare({ ...command, idempotencyKey: randomUUID() })).status).toBe('completed');
    await carts.closeOwner({ ownerUuid: fixture.ownerUuid, idempotencyKey: randomUUID() });
    expect(await checkoutQueries.get(base)).toEqual({
      checkoutUuid: base.checkoutUuid,
      cartUuid: cart.uuid,
      status: 'completed',
    });
    await expect(checkoutQueries.get({ ...base, ownerUuid: randomUUID() })).rejects.toThrow('not found');
    await expect(checkoutQueries.get({ ...base, shopUuid: randomUUID() })).rejects.toThrow('not found');
  });

  it('exposes cancellation tombstones and leaves the selection available', async () => {
    await add();
    const cart = await view();
    const base = { ...scope(), cartUuid: cart.uuid, checkoutUuid: randomUUID() };
    await checkouts.cancel({ ...base, idempotencyKey: randomUUID() });
    expect(await checkoutQueries.get(base)).toEqual({
      checkoutUuid: base.checkoutUuid,
      cartUuid: cart.uuid,
      status: 'cancelled',
    });
    expect((await view()).items[0].canCheckout).toBe(true);
  });

  it('locks only selected rows, cancels safely and completes once', async () => {
    await add(2);
    await add(1, fixture.secondRecordUuid);
    const cart = await view();
    const selected = cart.items.find((i) => i.recordUuid === fixture.recordUuid)!;
    const base = { ...scope(), cartUuid: cart.uuid, checkoutUuid: randomUUID() };
    await checkouts.prepare({
      ...base,
      idempotencyKey: randomUUID(),
      items: [{ recordUuid: selected.recordUuid, quantity: 2, expectedItemVersion: selected.version }],
    });
    await expect(add()).rejects.toThrow('checked out');
    await add(1, fixture.secondRecordUuid);
    await checkouts.cancel({ ...base, idempotencyKey: randomUUID() });
    expect((await view()).items.find((i) => i.recordUuid === selected.recordUuid)?.checkoutUuid).toBeNull();
    const current = await view();
    const item = current.items.find((i) => i.recordUuid === selected.recordUuid)!;
    const next = { ...base, checkoutUuid: randomUUID() };
    const command = {
      ...next,
      idempotencyKey: randomUUID(),
      items: [{ recordUuid: item.recordUuid, quantity: item.quantity, expectedItemVersion: item.version }],
    };
    await checkouts.prepare(command);
    await checkouts.prepare({ ...command, idempotencyKey: randomUUID() });
    await checkouts.complete({ ...next, idempotencyKey: randomUUID() });
    const version = (await view()).version;
    await checkouts.complete({ ...next, idempotencyKey: randomUUID() });
    expect((await view()).version).toBe(version);
    expect((await view()).items).toHaveLength(1);
  });

  it('preserves a cancel-before-prepare tombstone and rejects wrong cart/owner', async () => {
    await add();
    const cart = await view();
    const item = cart.items[0],
      base = { ...scope(), cartUuid: cart.uuid, checkoutUuid: randomUUID() };
    await checkouts.cancel({ ...base, idempotencyKey: randomUUID() });
    const result = await checkouts.prepare({
      ...base,
      idempotencyKey: randomUUID(),
      items: [{ recordUuid: item.recordUuid, quantity: item.quantity, expectedItemVersion: item.version }],
    });
    expect(result.status).toBe('cancelled');
    expect((await view()).items[0].checkoutUuid).toBeNull();
    await expect(checkouts.complete({ ...base, idempotencyKey: randomUUID() })).rejects.toThrow('terminal');
    await expect(
      checkouts.cancel({ ...base, ownerUuid: randomUUID(), idempotencyKey: randomUUID() }),
    ).rejects.toThrow('not found');
  });

  it('applies Order completion and its replay atomically to only the prepared rows', async () => {
    await add();
    await add(2, fixture.secondRecordUuid);
    const cart = await view();
    const selected = cart.items.find((item) => item.recordUuid === fixture.recordUuid)!;
    const checkoutUuid = randomUUID();
    await checkouts.prepare({
      ...scope(),
      cartUuid: cart.uuid,
      checkoutUuid,
      idempotencyKey: randomUUID(),
      items: [
        {
          recordUuid: selected.recordUuid,
          quantity: selected.quantity,
          expectedItemVersion: selected.version,
        },
      ],
    });
    const event = {
      eventUuid: randomUUID(),
      producer: 'order_srv',
      eventType: 'order.checkout.completed',
      schemaVersion: 1,
      aggregateType: 'checkout',
      aggregateUuid: checkoutUuid,
      aggregateVersion: '3',
      occurredAt: new Date().toISOString(),
      payload: { ...scope(), cartUuid: cart.uuid },
    };
    const controller = new OrderEventsController(checkouts);
    const channel = { ack: jest.fn(), nack: jest.fn() };
    const context = new RmqContext([{}, channel, event.eventType]);
    await controller.complete(event, context);
    const finished = await view();
    expect(finished.items.map((item) => item.recordUuid)).toEqual([fixture.secondRecordUuid]);
    const [receipt] = await db.query('SELECT result FROM command_request WHERE command_id=$1', [
      event.eventUuid,
    ]);
    expect(receipt.result.status).toBe('completed');
    await controller.complete(event, context);
    await controller.complete({ ...event, eventUuid: randomUUID() }, context);
    expect((await view()).version).toBe(finished.version);
    expect(channel.ack).toHaveBeenCalledTimes(3);
    expect(channel.nack).not.toHaveBeenCalled();

    const log = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    try {
      await controller.complete(
        { ...event, payload: { ...event.payload, ownerUuid: randomUUID() } },
        context,
      );
      expect(channel.ack).toHaveBeenCalledTimes(3);
      expect(channel.nack).toHaveBeenCalledWith(context.getMessage(), false, false);
      expect((await view()).items[0].quantity).toBe(2);
    } finally {
      log.mockRestore();
    }
  });

  it('closes every shop for an owner and prevents replay/recreation even if initially empty', async () => {
    const addCommand = {
      ...scope(),
      recordUuid: fixture.recordUuid,
      quantity: 1,
      idempotencyKey: randomUUID(),
    };
    await carts.add(addCommand);
    const shop = randomUUID();
    await projections.synchronize('shop', { uuid: shop, name: 'Юг', version: 1 });
    await carts.get({ ...scope(), shopUuid: shop });
    await carts.closeOwner({ ownerUuid: fixture.ownerUuid, idempotencyKey: randomUUID() });
    await expect(view()).rejects.toThrow('closed');
    await expect(carts.add(addCommand)).rejects.toThrow('closed');
    await expect(carts.get({ ...scope(), shopUuid: shop })).rejects.toThrow('closed');
    const unused = randomUUID();
    await carts.closeOwner({ ownerUuid: unused, idempotencyKey: randomUUID() });
    await expect(carts.get({ ...scope(), ownerUuid: unused })).rejects.toThrow('closed');
  });

  it('finishes an old closed guest checkout without touching an account cart', async () => {
    await add();
    const cart = await view(),
      item = cart.items[0],
      base = { ...scope(), cartUuid: cart.uuid, checkoutUuid: randomUUID() };
    await checkouts.prepare({
      ...base,
      idempotencyKey: randomUUID(),
      items: [{ recordUuid: item.recordUuid, quantity: item.quantity, expectedItemVersion: item.version }],
    });
    await carts.closeOwner({ ownerUuid: fixture.ownerUuid, idempotencyKey: randomUUID() });
    const account = randomUUID();
    await add(2, fixture.recordUuid, account);
    await checkouts.complete({ ...base, idempotencyKey: randomUUID() });
    expect((await carts.get({ ...scope(), ownerUuid: account })).items[0].quantity).toBe(2);
  });

  it('provides paginated admin reads and closed cards without creating carts or events', async () => {
    await add();
    const first = await view();
    const otherShop = randomUUID();
    await projections.synchronize('shop', { uuid: otherShop, name: 'Юг', version: 1 });
    await carts.get({ ...scope(), shopUuid: otherShop });
    const otherOwner = randomUUID();
    await add(2, fixture.recordUuid, otherOwner);
    const closed = await carts.get({ ...scope(), ownerUuid: otherOwner });
    await carts.closeOwner({ ownerUuid: otherOwner, idempotencyKey: randomUUID() });
    const before = await db.query(
      'SELECT (SELECT count(*)::int FROM carts) carts,(SELECT count(*)::int FROM outbox_event) events',
    );
    stock.assertStock.mockClear();
    const query = (input: Partial<GetAllCartsDto>) => Object.assign(new GetAllCartsDto(), input);
    const page = await admin.getAll(query({ ownerUuid: fixture.ownerUuid, limit: 1 }));
    const second = await admin.getAll(
      query({ ownerUuid: fixture.ownerUuid, limit: 1, nextToken: page.meta.nextToken! }),
    );
    expect(page.meta).toEqual({ limit: 1, nextToken: expect.any(String) });
    expect(second.meta.nextToken).toBeNull();
    expect(second.items[0].uuid).not.toBe(page.items[0].uuid);
    const filtered = await admin.getAll(
      query({ ownerUuid: fixture.ownerUuid, shopUuid: fixture.shopUuid, status: 'active' }),
    );
    expect(filtered.items).toHaveLength(1);
    expect(filtered.items[0]).toMatchObject({
      uuid: first.uuid,
      ownerUuid: fixture.ownerUuid,
      itemsCount: 1,
      closedAt: null,
      shop: { uuid: fixture.shopUuid, name: 'Центр' },
    });
    expect((await admin.getAll(query({ ownerUuid: otherOwner, status: 'active' }))).items.length).toBe(0);
    expect((await admin.getAll(query({ ownerUuid: otherOwner, status: 'closed' }))).items[0].uuid).toBe(
      closed.uuid,
    );
    await expect(
      admin.getAll(query({ ownerUuid: fixture.ownerUuid, nextToken: 'invalid' })),
    ).rejects.toThrow();
    const detail = await admin.getByUuid(closed.uuid);
    expect(detail.closedAt).not.toBeNull();
    expect(detail.items[0].productName).toBe('Кофе');
    expect(detail.items[0].quantity).toBe(2);
    expect(detail.items[0]).toMatchObject({
      canCheckout: false,
      canIncrease: false,
      canDecrease: false,
      canRemove: false,
    });
    await expect(admin.getByUuid(randomUUID())).rejects.toThrow('not found');
    expect(
      await db.query(
        'SELECT (SELECT count(*)::int FROM carts) carts,(SELECT count(*)::int FROM outbox_event) events',
      ),
    ).toEqual(before);
    expect(stock.assertStock).not.toHaveBeenCalled();
  });

  it('binds admin mutations to the existing cart and retains stock/version/checkout guarantees', async () => {
    await add();
    const cart = await view();
    const input = {
      cartUuid: cart.uuid,
      idempotencyKey: randomUUID(),
      recordUuid: fixture.recordUuid,
      quantity: 1,
    };
    await admin.add(input);
    await admin.add(input);
    let item = (await view()).items[0];
    expect(item.quantity).toBe(2);
    await expect(
      admin.setQuantity({
        ...input,
        idempotencyKey: randomUUID(),
        expectedItemVersion: cart.items[0].version,
      }),
    ).rejects.toThrow('version conflict');
    await expect(
      admin.setQuantity({
        ...input,
        idempotencyKey: randomUUID(),
        quantity: 9,
        expectedItemVersion: item.version,
      }),
    ).rejects.toThrow();
    await admin.setQuantity({
      ...input,
      idempotencyKey: randomUUID(),
      quantity: 3,
      expectedItemVersion: item.version,
    });
    item = (await view()).items[0];
    const checkout = {
      ...scope(),
      cartUuid: cart.uuid,
      checkoutUuid: randomUUID(),
      idempotencyKey: randomUUID(),
    };
    await checkouts.prepare({
      ...checkout,
      items: [{ recordUuid: item.recordUuid, quantity: item.quantity, expectedItemVersion: item.version }],
    });
    item = (await view()).items[0];
    await expect(
      admin.remove({ ...input, idempotencyKey: randomUUID(), expectedItemVersion: item.version }),
    ).rejects.toThrow('checked out');
    await expect(admin.add({ ...input, idempotencyKey: randomUUID() })).rejects.toThrow('checked out');
    await checkouts.cancel({ ...checkout, idempotencyKey: randomUUID() });
    item = (await view()).items[0];
    const remove = { ...input, idempotencyKey: randomUUID(), expectedItemVersion: item.version };
    await admin.remove(remove);
    await admin.remove(remove);
    expect((await view()).items).toHaveLength(0);
    const before = (await db.query('SELECT count(*)::int n FROM carts'))[0].n;
    await expect(
      admin.add({ ...input, idempotencyKey: randomUUID(), cartUuid: randomUUID() }),
    ).rejects.toThrow('not found');
    expect((await db.query('SELECT count(*)::int n FROM carts'))[0].n).toBe(before);
    await carts.closeOwner({ idempotencyKey: randomUUID(), ownerUuid: fixture.ownerUuid });
    await expect(admin.add({ ...input, idempotencyKey: randomUUID() })).rejects.toThrow('closed');
    expect((await admin.getByUuid(cart.uuid)).closedAt).not.toBeNull();
  });

  it('durably addresses projection notifications and protects outbox claim concurrency', async () => {
    await add();
    const cart = await view();
    fixture.product.version = 2;
    fixture.product.name = 'Изменено';
    await projections.apply(event('product', fixture.product));
    const [notice] = await db.query(
      "SELECT payload FROM outbox_event WHERE event_type='cart.projection.updated' AND aggregate_uuid=$1 ORDER BY occurred_at DESC LIMIT 1",
      [fixture.productUuid],
    );
    expect(notice.payload.targets).toContainEqual({
      cartUuid: cart.uuid,
      ownerUuid: fixture.ownerUuid,
      shopUuid: fixture.shopUuid,
    });
    const repo = new OutboxRepository(db, CART_OUTBOX_OPTIONS);
    const [a, b] = await Promise.all([
      repo.claimPublishableEvents({ batchSize: 5, maxAttempts: 10 }),
      repo.claimPublishableEvents({ batchSize: 5, maxAttempts: 10 }),
    ]);
    expect(a.length).toBeGreaterThan(0);
    expect(a.some((e) => b.some((f) => f.uuid === e.uuid))).toBe(false);
  });
});
