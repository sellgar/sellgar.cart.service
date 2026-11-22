import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';

import { ProjectionService } from '../projection/projection.service';
import { ProjectionRecoveryService } from './projection-recovery.service';
import { SourceGateway } from './source.gateway';

const fixture = () => {
  const gateway = {
    allShops: jest.fn().mockResolvedValue({ items: [], meta: { limit: 100, nextToken: null } }),
    allStoreProducts: jest.fn().mockResolvedValue({ items: [], meta: { limit: 100, nextToken: null } }),
  };
  const projections = { synchronize: jest.fn().mockResolvedValue(undefined) };
  const service = new ProjectionRecoveryService(
    {} as DataSource,
    gateway as unknown as SourceGateway,
    projections as unknown as ProjectionService,
    {} as ConfigService,
  );
  return { service, gateway, projections };
};

describe('Projection bootstrap cursor traversal', () => {
  it('visits every shop page and continues an empty Store page with a next token', async () => {
    const { service, gateway, projections } = fixture();
    gateway.allShops
      .mockResolvedValueOnce({ items: [{ uuid: 'shop-1' }], meta: { limit: 100, nextToken: 'next-shop' } })
      .mockResolvedValueOnce({ items: [{ uuid: 'shop-2' }], meta: { limit: 100, nextToken: null } });
    gateway.allStoreProducts
      .mockResolvedValueOnce({ items: [], meta: { limit: 100, nextToken: 'next-store' } })
      .mockResolvedValueOnce({ items: [], meta: { limit: 100, nextToken: null } });
    await expect(service.bootstrap()).resolves.toEqual({ products: 0 });
    expect(gateway.allShops.mock.calls).toEqual([[undefined], ['next-shop']]);
    expect(gateway.allStoreProducts.mock.calls).toEqual([[undefined], ['next-store']]);
    expect(projections.synchronize.mock.calls).toEqual([
      ['shop', { uuid: 'shop-1' }],
      ['shop', { uuid: 'shop-2' }],
    ]);
  });

  it('fails on a repeated token instead of looping or silently truncating bootstrap', async () => {
    const { service, gateway } = fixture();
    gateway.allShops.mockResolvedValue({ items: [], meta: { limit: 100, nextToken: 'same' } });
    await expect(service.bootstrap()).rejects.toThrow('Invalid cursor page');
    expect(gateway.allShops).toHaveBeenCalledTimes(2);
    expect(gateway.allStoreProducts).not.toHaveBeenCalled();
  });

  it('rejects a response without an explicit continuation state', async () => {
    const { service, gateway } = fixture();
    gateway.allShops.mockResolvedValue({ items: [], meta: { limit: 100 } });
    await expect(service.bootstrap()).rejects.toThrow('Invalid cursor page');
  });
});
