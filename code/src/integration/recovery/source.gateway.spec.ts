import { ConfigService } from '@nestjs/config';
import { ClientProxy } from '@nestjs/microservices';
import { of, throwError } from 'rxjs';

import { SourceGateway } from './source.gateway';

describe('Authoritative Store quantity checks', () => {
  const product = {
    uuid: 'product',
    shopUuid: 'shop',
    status: 'active',
    showing: true,
    offers: [
      {
        uuid: 'offer',
        status: 'active',
        showing: true,
        records: [{ uuid: 'record', inventory: { quantity: 5, reserved: 2 } }],
      },
    ],
  };
  const client = { send: jest.fn() };
  const gateway = new SourceGateway(
    client as unknown as ClientProxy,
    client as unknown as ClientProxy,
    client as unknown as ClientProxy,
    new ConfigService({ SOURCE_REQUEST_TIMEOUT_MS: '5000' }),
  );

  it('accepts configuration strings and uses quantity minus reservation', async () => {
    client.send.mockReturnValue(of(product));
    await expect(gateway.assertStock('product', 'offer', 'record', 'shop', 3)).resolves.toBeUndefined();
    await expect(gateway.assertStock('product', 'offer', 'record', 'shop', 4)).rejects.toThrow(
      'requested quantity',
    );
  });

  it('distinguishes source outage from sale restrictions', async () => {
    client.send.mockReturnValue(throwError(() => new Error('transport unavailable')));
    await expect(gateway.assertStock('product', 'offer', 'record', 'shop', 1)).rejects.toThrow(
      'source is unavailable',
    );
    client.send.mockReturnValue(of({ ...product, showing: false }));
    await expect(gateway.assertStock('product', 'offer', 'record', 'shop', 1)).rejects.toThrow(
      'sellable record',
    );
  });

  it('uses full snapshots to distinguish an archived sale from a missing ordinary card', async () => {
    client.send.mockClear();
    client.send.mockReturnValue(of(product));
    await gateway.storeProductSnapshot('product');
    await gateway.allStoreProducts('next');
    await gateway.catalogProduct('catalog');
    await gateway.assertStock('product', 'offer', 'record', 'shop', 1);
    expect(client.send.mock.calls).toEqual([
      [{ cmd: 'store.product.getSnapshot' }, { uuid: 'product' }],
      [{ cmd: 'store.product.getSnapshots' }, { query: { limit: 100, nextToken: 'next' } }],
      [{ cmd: 'catalog.v2.product.getSnapshot' }, { uuid: 'catalog' }],
      [{ cmd: 'store.product.getSnapshot' }, { uuid: 'product' }],
    ]);
  });
});
