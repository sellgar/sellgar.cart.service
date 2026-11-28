import { randomUUID } from 'node:crypto';

import { ValidationPipe } from '@nestjs/common';

import { PrepareCartDto } from './prepare-cart.dto';
import { PreviewCartDto } from './preview-cart.dto';

describe('Checkout selection boundary', () => {
  const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
  const selection = () => ({
    ownerUuid: randomUUID(),
    shopUuid: randomUUID(),
    cartUuid: randomUUID(),
    items: [{ recordUuid: randomUUID(), quantity: 1, expectedItemVersion: '1' }],
  });
  const check = (input: object, metatype = PreviewCartDto) =>
    pipe.transform(input, { type: 'body', metatype });

  it('normalizes record identifiers before duplicate validation', async () => {
    const input = selection();
    const recordUuid = input.items[0].recordUuid;
    const result = await check({
      ...input,
      items: [{ ...input.items[0], recordUuid: recordUuid.toUpperCase() }],
    });
    expect(result.items[0].recordUuid).toBe(recordUuid);
    await expect(
      check({
        ...input,
        items: [input.items[0], { ...input.items[0], recordUuid: recordUuid.toUpperCase() }],
      }),
    ).rejects.toThrow();
  });

  it.each([0, -1, 1.5, 2147483648, '1'])('rejects invalid quantity %s', async (quantity) => {
    const input = selection();
    await expect(check({ ...input, items: [{ ...input.items[0], quantity }] })).rejects.toThrow();
  });

  it('rejects empty selection, missing versions and client money', async () => {
    const input = selection();
    await expect(check({ ...input, items: [] })).rejects.toThrow();
    await expect(check({ ...input, items: [{ recordUuid: randomUUID(), quantity: 1 }] })).rejects.toThrow();
    await expect(check({ ...input, items: [{ ...input.items[0], unitPrice: '0.01' }] })).rejects.toThrow();
    await expect(check({ ...input, itemsTotal: '0.01' })).rejects.toThrow();
  });

  it('keeps the same selection contract for preparation', async () => {
    const input = { ...selection(), checkoutUuid: randomUUID(), idempotencyKey: randomUUID() };
    await expect(check(input, PrepareCartDto)).resolves.toMatchObject(input);
    await expect(check({ ...input, items: [] }, PrepareCartDto)).rejects.toThrow();
  });
});
