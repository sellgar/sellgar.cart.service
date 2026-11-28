import { randomUUID } from 'node:crypto';

import { checked } from '../../common/checked';
import { CheckoutCompletedEvent } from './checkout-completed.event';

describe('Order completion envelope', () => {
  const event = () => ({
    eventUuid: randomUUID(),
    producer: 'order_srv',
    eventType: 'order.checkout.completed',
    aggregateType: 'checkout',
    aggregateUuid: randomUUID(),
    aggregateVersion: '1',
    schemaVersion: 1,
    occurredAt: new Date().toISOString(),
    payload: { ownerUuid: randomUUID(), shopUuid: randomUUID(), cartUuid: randomUUID() },
  });

  it('accepts bigint versions from the shared PostgreSQL outbox without losing precision', async () => {
    const input = { ...event(), aggregateVersion: '9223372036854775807' };
    expect((await checked(CheckoutCompletedEvent, input)).aggregateVersion).toBe(input.aggregateVersion);
  });

  it('preserves compatibility with safe integer envelopes', async () => {
    expect(
      (await checked(CheckoutCompletedEvent, { ...event(), aggregateVersion: 3 })).aggregateVersion,
    ).toBe('3');
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '0', '-1', '01', '1.5'])(
    'rejects invalid version %s',
    async (aggregateVersion) => {
      await expect(checked(CheckoutCompletedEvent, { ...event(), aggregateVersion })).rejects.toThrow(
        'Invalid',
      );
    },
  );
});
