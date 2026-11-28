import 'reflect-metadata';

import { OutboxWriter } from '@sellgar/outbox';
import { INestMicroservice, Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClientProxy, ClientProxyFactory, Transport } from '@nestjs/microservices';
import { Test } from '@nestjs/testing';
import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { parseEnv } from 'node:util';
import { firstValueFrom, timeout } from 'rxjs';
import { DataSource } from 'typeorm';

import { CartController } from '../src/api/v1/cart/controller/cart.controller';
import { CartCommandRepository } from '../src/api/v1/cart/repository/cart-command.repository';
import { CartQueryRepository } from '../src/api/v1/cart/repository/cart-query.repository';
import { CartRepository } from '../src/api/v1/cart/repository/cart.repository';
import { CartCheckoutQueryService } from '../src/api/v1/cart/service/cart-checkout-query.service';
import { CartCheckoutService } from '../src/api/v1/cart/service/cart-checkout.service';
import { CartSelectionFactory } from '../src/api/v1/cart/service/cart-selection.factory';
import { CartService } from '../src/api/v1/cart/service/cart.service';
import { CheckoutStateMachine } from '../src/api/v1/cart/service/checkout-state-machine';
import { RpcHttpExceptionFilter } from '../src/common/rpc-http-exception.filter';
import { CartDatabaseOptions } from '../src/database/cart-database.options';
import { CART_OUTBOX_OPTIONS } from '../src/integration/outbox/cart-outbox.options';
import { CartEventsRepository } from '../src/integration/outbox/cart-events.repository';
import { ProjectionService } from '../src/integration/projection/projection.service';
import { ProjectionRecoveryService } from '../src/integration/recovery/projection-recovery.service';
import { SourceGateway } from '../src/integration/recovery/source.gateway';

if (existsSync('.env')) {
  for (const [key, value] of Object.entries(parseEnv(readFileSync('.env', 'utf8')))) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

describe('Cart checkout RabbitMQ boundary', () => {
  const suffix = randomUUID().replace(/-/g, '');
  const schema = `cart_checkout_rmq_${suffix}`;
  const queue = `cart.checkout.test.${suffix}`;
  const scope = { ownerUuid: randomUUID(), shopUuid: randomUUID() };
  const productUuid = randomUUID(),
    variantUuid = randomUUID(),
    recordUuid = randomUUID();
  const storeUuid = randomUUID(),
    offerUuid = randomUUID();
  const shop = { uuid: scope.shopUuid, name: 'Тестовый магазин', version: 1 };
  const product = {
    uuid: productUuid,
    name: 'Тарелка',
    status: 'active',
    version: 1,
    variants: [{ uuid: variantUuid, name: 'Белая', status: 'active', images: [] }],
  };
  const store = {
    uuid: storeUuid,
    shopUuid: scope.shopUuid,
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
        records: [
          {
            uuid: recordUuid,
            offerUuid,
            article: 'TEST-PLATE',
            clarifications: [{ position: 0, value: '250 мм' }],
            currentPrice: { uuid: randomUUID(), recordUuid, value: '125.50', currencyCode: 'RUB' },
            inventory: { uuid: randomUUID(), recordUuid, version: 1, quantity: 10, reserved: 0 },
          },
        ],
      },
    ],
  };
  let db: DataSource;
  let app: INestMicroservice | undefined;
  let client: ClientProxy | undefined;

  const call = (cmd: string, input: object) =>
    firstValueFrom(client!.send({ cmd }, input).pipe(timeout(5000)));

  beforeAll(async () => {
    Logger.overrideLogger(['warn', 'error']);
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

    const module = await Test.createTestingModule({
      controllers: [CartController],
      providers: [
        { provide: DataSource, useValue: db },
        {
          provide: ConfigService,
          useValue: new ConfigService({
            CART_CURRENCY_CODE: 'RUB',
            CART_BOOTSTRAP_ON_START: 'false',
            CART_RECOVERY_INTERVAL_MS: 60000,
          }),
        },
        { provide: OutboxWriter, useValue: new OutboxWriter(CART_OUTBOX_OPTIONS) },
        {
          provide: SourceGateway,
          useValue: {
            assertStock: async () => {},
            storeProductByRecord: async () => store,
            shopByUuid: async () => shop,
            catalogProduct: async () => product,
          },
        },
        CartCommandRepository,
        CartRepository,
        CartQueryRepository,
        CartEventsRepository,
        CartService,
        CartCheckoutService,
        CartCheckoutQueryService,
        CartSelectionFactory,
        CheckoutStateMachine,
        ProjectionService,
        ProjectionRecoveryService,
      ],
    }).compile();
    const projections = module.get(ProjectionService);
    await projections.synchronize('shop', shop);
    await projections.synchronize('product', product);
    await projections.synchronize('store_product', store);

    const options = {
      urls: [
        {
          hostname: process.env.AMQP_HOSTNAME,
          port: Number(process.env.AMQP_PORT),
          username: process.env.AMQP_USERNAME,
          password: process.env.AMQP_PASSWORD,
        },
      ],
      queue,
      queueOptions: { durable: false, autoDelete: true },
    };
    app = module.createNestMicroservice({ transport: Transport.RMQ, options });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new RpcHttpExceptionFilter());
    await app.listen();
    client = ClientProxyFactory.create({ transport: Transport.RMQ, options });
    await client.connect();
  });

  afterAll(async () => {
    client?.close();
    await app?.close();
    if (db?.isInitialized) {
      await db.query(`DROP SCHEMA "${schema}" CASCADE`);
      await db.destroy();
    }
  });

  it('previews selected lines, validates input and recovers prepared/cancelled state over real RMQ', async () => {
    await call('cart.item.add', { ...scope, recordUuid, quantity: 2, idempotencyKey: randomUUID() });
    const cart = await call('cart.get', scope);
    const input = {
      ...scope,
      cartUuid: cart.uuid,
      items: [{ recordUuid, quantity: 2, expectedItemVersion: cart.items[0].version }],
    };
    const calculation = await call('cart.checkout.preview', input);
    expect(calculation.itemsTotal).toBe('251.00');
    expect(calculation.items[0].productName).toBe('Тарелка');
    expect(await call('cart.get', scope)).toEqual(cart);

    await expect(call('cart.checkout.preview', { ...input, itemsTotal: '0.01' })).rejects.toMatchObject({
      statusCode: 400,
    });
    await expect(
      call('cart.checkout.preview', { ...input, items: [{ ...input.items[0], quantity: 0 }] }),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(call('cart.checkout.preview', { ...input, ownerUuid: randomUUID() })).rejects.toMatchObject({
      statusCode: 404,
    });

    const identity = { ...scope, cartUuid: cart.uuid, checkoutUuid: randomUUID() };
    const command = { ...input, checkoutUuid: identity.checkoutUuid, idempotencyKey: randomUUID() };
    const receipt = await call('cart.checkout.prepare', command);
    expect(await call('cart.checkout.prepare', command)).toEqual(receipt);
    expect(await call('cart.checkout.get', identity)).toEqual({
      checkoutUuid: identity.checkoutUuid,
      cartUuid: cart.uuid,
      status: 'prepared',
    });
    await call('cart.checkout.cancel', { ...identity, idempotencyKey: randomUUID() });
    expect((await call('cart.checkout.get', identity)).status).toBe('cancelled');
    expect((await call('cart.get', scope)).items[0].canCheckout).toBe(true);
    expect(calculation.itemsTotal).toBe('251.00');
  });
});
