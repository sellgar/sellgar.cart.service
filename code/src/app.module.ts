import { PaginationModule } from '@sellgar/pagination';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OutboxModule } from '@sellgar/outbox';

import { HealthModule } from './health/health.module';
import { IdentityEventsController } from './integration/identity/identity-events.controller';
import { CartController } from './api/v1/cart/controller/cart.controller';
import { CartAdminController } from './api/v1/cart/controller/cart-admin.controller';
import { CartAdminQueryRepository } from './api/v1/cart/repository/cart-admin-query.repository';
import { CartAdminService } from './api/v1/cart/service/cart-admin.service';
import { CartCommandRepository } from './api/v1/cart/repository/cart-command.repository';
import { CartQueryRepository } from './api/v1/cart/repository/cart-query.repository';
import { CartRepository } from './api/v1/cart/repository/cart.repository';
import { CartCheckoutService } from './api/v1/cart/service/cart-checkout.service';
import { CartCheckoutQueryService } from './api/v1/cart/service/cart-checkout-query.service';
import { CartSelectionFactory } from './api/v1/cart/service/cart-selection.factory';
import { CheckoutStateMachine } from './api/v1/cart/service/checkout-state-machine';
import { CartService } from './api/v1/cart/service/cart.service';
import { CartDatabaseOptions } from './database/cart-database.options';
import { OrderEventsController } from './integration/order/order-events.controller';
import { CartEventsRepository } from './integration/outbox/cart-events.repository';
import { CART_OUTBOX_OPTIONS } from './integration/outbox/cart-outbox.options';
import { ProjectionController } from './integration/projection/projection.controller';
import { ProjectionService } from './integration/projection/projection.service';
import { ProjectionRecoveryService } from './integration/recovery/projection-recovery.service';
import {
  SOURCE_PRODUCT,
  SOURCE_SHOP,
  SOURCE_STORE,
  SourceGateway,
} from './integration/recovery/source.gateway';

const clients = [
  { name: SOURCE_STORE, queue: 'AMQP_STORE_SRV_COMMAND_QUEUE' },
  { name: SOURCE_PRODUCT, queue: 'PRODUCT_COMMAND_QUEUE' },
  { name: SOURCE_SHOP, queue: 'AMQP_SHOP_SRV_COMMAND_QUEUE' },
  { name: CART_OUTBOX_OPTIONS.eventClientToken, queue: null },
];

@Module({
  imports: [
    PaginationModule,
    HealthModule,
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
      validate: (env: Record<string, unknown>) => {
        if (!/^[A-Z]{3}$/.test(String(env.CART_CURRENCY_CODE ?? '')))
          throw new Error('CART_CURRENCY_CODE must be configured');
        return env;
      },
    }),
    TypeOrmModule.forRootAsync({ useFactory: () => CartDatabaseOptions.create(process.env) }),
    ClientsModule.registerAsync({
      isGlobal: true,
      clients: clients.map((client) => ({
        name: client.name,
        inject: [ConfigService],
        useFactory: (config: ConfigService) => ({
          transport: Transport.RMQ,
          options: {
            urls: [
              {
                hostname: config.getOrThrow('AMQP_HOSTNAME'),
                port: Number(config.get('AMQP_PORT', 5672)),
                username: config.getOrThrow('AMQP_USERNAME'),
                password: config.getOrThrow('AMQP_PASSWORD'),
              },
            ],
            queue: client.queue ? config.getOrThrow<string>(client.queue) : '',
            queueOptions: client.queue ? { durable: true } : { durable: false, autoDelete: true },
            persistent: true,
            ...(client.queue
              ? {}
              : {
                  exchange: config.getOrThrow('AMQP_EVENTS_EXCHANGE'),
                  exchangeType: 'topic',
                  wildcards: true,
                }),
          },
        }),
      })),
    }),
    OutboxModule.forRoot(CART_OUTBOX_OPTIONS),
  ],
  controllers: [
    CartController,
    CartAdminController,
    ProjectionController,
    OrderEventsController,
    IdentityEventsController,
  ],
  providers: [
    CartAdminQueryRepository,
    CartAdminService,
    CartCommandRepository,
    CartQueryRepository,
    CartRepository,
    CartService,
    CartCheckoutService,
    CartCheckoutQueryService,
    CartSelectionFactory,
    CheckoutStateMachine,
    CartEventsRepository,
    ProjectionService,
    ProjectionRecoveryService,
    SourceGateway,
  ],
})
export class AppModule {}
