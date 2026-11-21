import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { Logger } from '@nestjs/common';
import { ClientProxyFactory, Transport } from '@nestjs/microservices';
import { connect } from 'amqplib';
import { firstValueFrom, timeout } from 'rxjs';
import { DataSource } from 'typeorm';

import { CartDatabaseOptions } from '../src/database/cart-database.options';
import { CartView } from '../src/api/v1/cart/entity/cart-view.entity';

if (existsSync('.env')) process.loadEnvFile('.env');

async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const value = await read();
    if (ready(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for the observable outcome');
}

async function smoke(): Promise<void> {
  Logger.overrideLogger(['warn', 'error']);
  const suffix = randomUUID().replace(/-/g, '');
  const schema = `cart_smoke_${suffix}`;
  const queue = `cart.smoke.${suffix}.commands`,
    eventQueue = `cart.smoke.${suffix}.events`,
    exchange = `cart.smoke.${suffix}`;
  const baseEnv = { ...process.env };
  const control = await new DataSource({
    ...CartDatabaseOptions.create(baseEnv),
    entities: [],
    migrations: [],
  }).initialize();
  const connection = await connect({
    hostname: process.env.AMQP_HOSTNAME,
    port: Number(process.env.AMQP_PORT),
    username: process.env.AMQP_USERNAME,
    password: process.env.AMQP_PASSWORD,
  });
  const channel = await connection.createConfirmChannel();
  let app: Awaited<ReturnType<typeof import('../src/bootstrap').createCartApplication>> | undefined;
  let client: ReturnType<typeof ClientProxyFactory.create> | undefined;
  let created = false;
  const notices: any[] = [];
  try {
    await control.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    Object.assign(process.env, {
      CART_DATABASE_SCHEMA: schema,
      AMQP_CART_SRV_COMMAND_QUEUE: queue,
      AMQP_CART_SRV_EVENT_QUEUE: eventQueue,
      AMQP_EVENTS_EXCHANGE: exchange,
      CART_BOOTSTRAP_ON_START: 'false',
      OUTBOX_PUBLISH_INTERVAL_MS: '50',
    });
    const migration = await new DataSource(CartDatabaseOptions.create(process.env)).initialize();
    try {
      await migration.runMigrations();
    } finally {
      await migration.destroy();
    }
    await channel.assertExchange(exchange, 'topic', { durable: true });
    const observer = await channel.assertQueue('', { exclusive: true, autoDelete: true });
    await channel.bindQueue(observer.queue, exchange, 'cart.#');
    await channel.consume(observer.queue, (message) => {
      if (message) {
        notices.push(JSON.parse(message.content.toString()).data);
        channel.ack(message);
      }
    });
    const { createCartApplication } = await import('../src/bootstrap');
    app = await createCartApplication();
    client = ClientProxyFactory.create({
      transport: Transport.RMQ,
      options: {
        urls: [
          {
            hostname: process.env.AMQP_HOSTNAME,
            port: Number(process.env.AMQP_PORT),
            username: process.env.AMQP_USERNAME,
            password: process.env.AMQP_PASSWORD,
          },
        ],
        queue,
        queueOptions: { durable: true },
      },
    });
    const call = (cmd: string, input: object = {}) =>
      firstValueFrom(client!.send({ cmd }, input).pipe(timeout(10000)));
    assert.equal((await call('cart.health')).status, 'ok');
    const { ProjectionRecoveryService } =
      await import('../src/integration/recovery/projection-recovery.service');
    await app.get(ProjectionRecoveryService).bootstrap();
    for (const cmd of [
      'cart.getCurrent',
      'cart.projection.bootstrap',
      'cart.projection.synchronize',
      'cart.checkout.complete',
    ]) {
      await assert.rejects(() => call(cmd), /no matching message handler/i);
    }
    const db = app.get(DataSource);
    const [record] = await db.query(
      `SELECT ar.uuid,sp.shop_uuid,sp.uuid store_uuid,sp.product_uuid FROM accounting_record_snapshot ar
      JOIN store_offer_snapshot o ON o.uuid=ar.offer_uuid JOIN store_product_snapshot sp ON sp.uuid=o.store_product_uuid
      JOIN product_snapshot p ON p.uuid=sp.product_uuid JOIN variant_snapshot v ON v.uuid=o.variant_uuid
      JOIN record_inventory_snapshot i ON i.record_uuid=ar.uuid WHERE sp.status='active' AND sp.showing AND o.status='active' AND o.showing
      AND p.status='active' AND v.status='active' AND i.available>0 AND o.currency_code=$1 LIMIT 1`,
      [process.env.CART_CURRENCY_CODE],
    );
    assert.ok(record, 'Existing services must contain a sellable record for this smoke');
    const scope = { ownerUuid: randomUUID(), shopUuid: record.shop_uuid };
    const read = () => call('cart.get', scope) as Promise<CartView>;
    const cart = await read();
    const add = { ...scope, recordUuid: record.uuid, quantity: 1, idempotencyKey: randomUUID() };
    await Promise.all([call('cart.item.add', add), call('cart.item.add', add)]);
    let result = await read();
    assert.equal(result.items[0].quantity, 1);
    assert.ok(result.items[0].productName);
    assert.ok(result.items[0].variantName);
    assert.ok(result.shop.name);
    const adminPage = await call('cart.admin.getAll', {
      ownerUuid: scope.ownerUuid,
      shopUuid: scope.shopUuid,
      limit: 1,
      offset: 0,
    });
    assert.equal(adminPage.meta.totalRows, 1);
    assert.equal(adminPage.data[0].uuid, cart.uuid);
    assert.equal(adminPage.data[0].itemsCount, 1);
    let adminView = await call('cart.admin.getByUuid', { uuid: cart.uuid });
    assert.equal(adminView.ownerUuid, scope.ownerUuid);
    assert.equal(adminView.items[0].productName, result.items[0].productName);
    await call('cart.admin.item.setQuantity', {
      cartUuid: cart.uuid,
      recordUuid: record.uuid,
      idempotencyKey: randomUUID(),
      quantity: 1,
      expectedItemVersion: adminView.items[0].version,
    });
    adminView = await call('cart.admin.getByUuid', { uuid: cart.uuid });
    await call('cart.admin.item.remove', {
      cartUuid: cart.uuid,
      recordUuid: record.uuid,
      idempotencyKey: randomUUID(),
      expectedItemVersion: adminView.items[0].version,
    });
    const adminAdd = {
      cartUuid: cart.uuid,
      recordUuid: record.uuid,
      idempotencyKey: randomUUID(),
      quantity: 1,
    };
    await call('cart.admin.item.add', adminAdd);
    await call('cart.admin.item.add', adminAdd);
    assert.equal((await read()).items[0].quantity, 1);
    const source = app.get((await import('../src/integration/recovery/source.gateway')).SourceGateway);
    const store = await source.storeProduct(record.store_uuid),
      product = await source.catalogProduct(record.product_uuid),
      shop = await source.shopByUuid(record.shop_uuid);
    const publish = async (kind: string, payload: any) => {
      const eventType =
        kind === 'store_product'
          ? 'store.product.updated'
          : kind === 'record_inventory'
            ? 'store.inventory.updated'
            : `${kind}.updated`;
      const event = {
        eventUuid: randomUUID(),
        eventType,
        producer: kind === 'product' ? 'product_srv' : kind === 'shop' ? 'shop_srv' : 'store_srv',
        schemaVersion: kind === 'record_inventory' ? 2 : 3,
        aggregateType: kind,
        aggregateUuid: payload.uuid,
        aggregateVersion: payload.version,
        occurredAt: new Date().toISOString(),
        payload,
      };
      channel.publish(exchange, eventType, Buffer.from(JSON.stringify({ pattern: eventType, data: event })), {
        persistent: true,
      });
      await channel.waitForConfirms();
    };
    product.version++;
    product.name = 'Cart isolated smoke product';
    await publish('product', product);
    await until(read, (v) => v.items[0].productName === product.name);
    shop.version++;
    shop.name = 'Cart isolated smoke shop';
    await publish('shop', shop);
    await until(read, (v) => v.shop.name === shop.name);
    store.version++;
    store.showing = false;
    await publish('store_product', store);
    await until(read, (v) => v.items[0].message === 'Временно недоступен');
    await assert.rejects(() => call('cart.item.add', { ...add, idempotencyKey: randomUUID() }));
    store.version++;
    store.status = 'disabled';
    await publish('store_product', store);
    await until(read, (v) => v.items[0].message === 'Товар больше не продается');
    const inventory = store.offers
      .flatMap((o: any) => o.records)
      .find((r: any) => r.uuid === record.uuid).inventory;
    const original = { ...inventory };
    inventory.version++;
    inventory.quantity = 0;
    inventory.reserved = 0;
    await publish('record_inventory', inventory);
    store.version++;
    store.status = 'active';
    store.showing = true;
    await publish('store_product', store);
    await until(read, (v) => v.items[0].message === 'Нет в наличии');
    inventory.version++;
    inventory.quantity = original.quantity;
    inventory.reserved = original.reserved;
    await publish('record_inventory', inventory);
    result = await until(read, (v) => v.items[0].canCheckout);
    const item = result.items[0],
      base = { ...scope, cartUuid: cart.uuid, checkoutUuid: randomUUID() };
    await call('cart.checkout.prepare', {
      ...base,
      idempotencyKey: randomUUID(),
      items: [{ recordUuid: item.recordUuid, quantity: item.quantity, expectedItemVersion: item.version }],
    });
    await assert.rejects(() =>
      call('cart.item.remove', {
        ...scope,
        idempotencyKey: randomUUID(),
        recordUuid: item.recordUuid,
        expectedItemVersion: item.version,
      }),
    );
    const completed = {
      eventUuid: randomUUID(),
      producer: 'order_srv',
      eventType: 'order.checkout.completed',
      schemaVersion: 1,
      aggregateType: 'checkout',
      aggregateUuid: base.checkoutUuid,
      aggregateVersion: 3,
      occurredAt: new Date().toISOString(),
      payload: { ...scope, cartUuid: cart.uuid },
    };
    const publishCompletion = async (event: typeof completed) => {
      channel.publish(
        exchange,
        completed.eventType,
        Buffer.from(JSON.stringify({ pattern: completed.eventType, data: event })),
        { persistent: true },
      );
      await channel.waitForConfirms();
    };
    await publishCompletion({ ...completed, eventUuid: randomUUID(), producer: 'unsupported' });
    await until(
      () => channel.checkQueue(`${eventQueue}.dead`),
      (q) => q.messageCount === 1,
    );
    assert.equal((await read()).items[0].checkoutUuid, base.checkoutUuid);
    await publishCompletion(completed);
    await publishCompletion(completed);
    const finished = await until(read, (v) => v.items.length === 0);
    // Wait until a separately identified replay is committed as well.
    const replay = { ...completed, eventUuid: randomUUID() };
    await publishCompletion(replay);
    await until(
      () => db.query('SELECT command_id FROM command_request WHERE command_id=$1', [replay.eventUuid]),
      (rows) => rows.length === 1,
    );
    assert.equal((await read()).version, finished.version);
    await call('cart.owner.close', { ownerUuid: scope.ownerUuid, idempotencyKey: randomUUID() });
    await assert.rejects(read);
    await until(
      async () => notices,
      (values) =>
        values.some(
          (e) =>
            e?.eventType === 'cart.projection.updated' &&
            e.payload.targets.some((t: any) => t.ownerUuid === scope.ownerUuid),
        ),
    );
    const malformed = { eventUuid: randomUUID(), producer: 'unsupported', eventType: 'product.updated' };
    channel.publish(
      exchange,
      'product.updated',
      Buffer.from(JSON.stringify({ pattern: 'product.updated', data: malformed })),
      { persistent: true },
    );
    await channel.waitForConfirms();
    await until(
      () => channel.checkQueue(`${eventQueue}.dead`),
      (q) => q.messageCount === 2,
    );
    console.log(
      'PASS: internal bootstrap, customer/admin RMQ API, admin mutations/replay, catalog/shop/inventory events, Order completion/replay, checkout locks, owner closure, durable notifications and dead-letter rejection',
    );
  } finally {
    if (client) await client.close();
    if (app) await app.close();
    for (const name of [queue, eventQueue, `${eventQueue}.dead`])
      await channel.deleteQueue(name).catch(() => undefined);
    await channel.deleteExchange(exchange).catch(() => undefined);
    await channel.deleteExchange(`${eventQueue}.dead.exchange`).catch(() => undefined);
    await channel.close();
    await connection.close();
    if (created) await control.query(`DROP SCHEMA "${schema}" CASCADE`);
    await control.destroy();
  }
}

void smoke().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
