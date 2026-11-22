import { CursorPage } from '@sellgar/pagination';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { legacyStoreSnapshot, storePayload } from '../projection/store-payload';
import { ProjectionKind } from '../projection/integration-event';
import { ProjectionService } from '../projection/projection.service';
import { SourceGateway } from './source.gateway';

@Injectable()
export class ProjectionRecoveryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ProjectionRecoveryService.name);
  private timer?: ReturnType<typeof setInterval>;
  private pending?: Promise<void>;
  private stopped = false;
  private bootstrapped = false;

  constructor(
    @InjectDataSource() private readonly source: DataSource,
    private readonly gateway: SourceGateway,
    private readonly projections: ProjectionService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    this.bootstrapped = String(this.config.get('CART_BOOTSTRAP_ON_START', 'true')) !== 'true';
    this.timer = setInterval(() => this.tick(), Number(this.config.get('CART_RECOVERY_INTERVAL_MS', 5000)));
    this.tick();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.pending;
  }

  async synchronize(kind: ProjectionKind, uuid: string): Promise<void> {
    switch (kind) {
      case 'shop':
        await this.projections.synchronize('shop', await this.gateway.shopByUuid(uuid));
        return;
      case 'product':
        await this.projections.synchronize('product', await this.gateway.catalogProduct(uuid));
        return;
      case 'store_product':
        await this.storeProduct(await this.gateway.storeProduct(uuid));
        return;
      case 'record_inventory':
        await this.storeProduct(await this.gateway.storeProductByRecord(uuid));
        return;
    }
  }

  async bootstrap(): Promise<{ products: number }> {
    await this.visitPages(
      (token) => this.gateway.allShops(token),
      (shop) => this.projections.synchronize('shop', shop),
    );
    const products = await this.visitPages(
      (token) => this.gateway.allStoreProducts(token),
      (product) => this.storeProduct(product),
    );
    return { products };
  }

  private async visitPages(
    load: (token?: string) => Promise<CursorPage<any>>,
    consume: (item: any) => Promise<unknown>,
  ): Promise<number> {
    const seen = new Set<string>();
    let nextToken: string | undefined;
    let count = 0;
    while (!this.stopped) {
      const page = await load(nextToken);
      const token = page?.meta?.nextToken;
      if (
        !Array.isArray(page.items) ||
        (token !== null && (typeof token !== 'string' || token.length === 0 || seen.has(token)))
      ) {
        throw new Error('Invalid cursor page from bootstrap source');
      }
      for (const item of page.items) {
        if (this.stopped) break;
        await consume(item);
        count += 1;
      }
      if (token === null) break;
      seen.add(token);
      nextToken = token;
    }
    return count;
  }

  async recover(): Promise<void> {
    const issues: {
      aggregate_type: ProjectionKind;
      aggregate_uuid: string;
      payload: { recordUuid?: string };
    }[] = await this.source.query(`SELECT ie.aggregate_type,ie.aggregate_uuid,ie.payload
      FROM sync_issue si JOIN inbox_event ie USING(event_uuid) WHERE si.resolved_at IS NULL ORDER BY si.created_at LIMIT 50`);
    for (const issue of issues) {
      if (this.stopped) break;
      try {
        const uuid =
          issue.aggregate_type === 'record_inventory' ? issue.payload.recordUuid : issue.aggregate_uuid;
        if (!uuid) throw new Error('Inventory recovery has no record reference');
        await this.synchronize(issue.aggregate_type, uuid);
      } catch {
        this.logger.warn(`Projection recovery pending: ${issue.aggregate_type}`);
      }
    }
  }

  private async storeProduct(product: any): Promise<void> {
    // Validate root first, before using its identifiers for owner requests.
    product = await storePayload(product, legacyStoreSnapshot(product));
    await this.synchronize('shop', product.shopUuid);
    await this.synchronize('product', product.productUuid);
    await this.projections.synchronize('store_product', product);
  }

  private tick(): void {
    if (this.pending || this.stopped) return;
    this.pending = (async () => {
      if (!this.bootstrapped) {
        await this.bootstrap();
        this.bootstrapped = true;
      }
      await this.recover();
    })()
      .catch(() => this.logger.warn('Projection bootstrap/recovery will retry'))
      .finally(() => {
        this.pending = undefined;
      });
  }
}
