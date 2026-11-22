import { BadGatewayException, ConflictException, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom, timeout } from 'rxjs';

export const SOURCE_STORE = 'SOURCE_STORE';
export const SOURCE_PRODUCT = 'SOURCE_PRODUCT';
export const SOURCE_SHOP = 'SOURCE_SHOP';

@Injectable()
export class SourceGateway {
  constructor(
    @Inject(SOURCE_STORE) private readonly store: ClientProxy,
    @Inject(SOURCE_PRODUCT) private readonly product: ClientProxy,
    @Inject(SOURCE_SHOP) private readonly shop: ClientProxy,
    private readonly config: ConfigService,
  ) {}

  storeProduct(uuid: string): Promise<any> {
    return this.request(this.store, 'store.product.getByUuid', { uuid, query: {} });
  }
  storeProductByRecord(recordUuid: string): Promise<any> {
    return this.request(this.store, 'store.product.getByRecordUuid', { recordUuid });
  }
  allStoreProducts(nextToken?: string): Promise<any> {
    return this.request(this.store, 'store.product.getAll', { query: { limit: 100, nextToken } });
  }
  catalogProduct(uuid: string): Promise<any> {
    return this.request(this.product, 'catalog.v2.product.getByUuid', { uuid });
  }
  allShops(nextToken?: string): Promise<any> {
    return this.request(this.shop, 'shop.getAll', { limit: 100, nextToken });
  }
  shopByUuid(uuid: string): Promise<any> {
    return this.request(this.shop, 'shop.getByUuid', { uuid });
  }

  async assertStock(
    storeProductUuid: string,
    offerUuid: string,
    recordUuid: string,
    shopUuid: string,
    quantity: number,
  ): Promise<void> {
    const product = await this.storeProduct(storeProductUuid);
    const offer = product.offers?.find((item: any) => item.uuid === offerUuid);
    const record = offer?.records?.find((item: any) => item.uuid === recordUuid);
    if (
      product.uuid !== storeProductUuid ||
      product.shopUuid !== shopUuid ||
      product.status !== 'active' ||
      product.showing !== true ||
      offer?.status !== 'active' ||
      offer?.showing !== true ||
      !record
    ) {
      throw new ConflictException('Store no longer confirms this sellable record');
    }
    const inventory = record.inventory;
    if (
      !Number.isSafeInteger(inventory?.quantity) ||
      !Number.isSafeInteger(inventory?.reserved) ||
      inventory.quantity - inventory.reserved < quantity
    ) {
      throw new ConflictException('Store does not confirm the requested quantity');
    }
  }

  private async request(client: ClientProxy, cmd: string, data: object): Promise<any> {
    try {
      return await firstValueFrom(
        client.send({ cmd }, data).pipe(timeout(Number(this.config.get('SOURCE_REQUEST_TIMEOUT_MS', 5000)))),
      );
    } catch {
      throw new BadGatewayException('Authoritative source is unavailable');
    }
  }
}
