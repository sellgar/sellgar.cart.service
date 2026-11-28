import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';

import { PreviewCartDto } from '../controller/dto/preview-cart.dto';
import { CartSelectionEntity } from '../entity/cart-selection.entity';
import { CartView } from '../entity/cart-view.entity';
import { sumPrices } from './money';

@Injectable()
export class CartSelectionFactory {
  create(cart: CartView, selection: PreviewCartDto): CartSelectionEntity {
    if (
      selection.items.length === 0 ||
      new Set(selection.items.map((item) => item.recordUuid)).size !== selection.items.length
    )
      throw new BadRequestException('Checkout selection must be nonempty and unique');

    const byRecord = new Map(cart.items.map((item) => [item.recordUuid, item]));
    const items = [...selection.items]
      .sort((a, b) => a.recordUuid.localeCompare(b.recordUuid))
      .map((selected) => {
        const item = byRecord.get(selected.recordUuid);
        if (!item || item.version !== selected.expectedItemVersion || item.quantity !== selected.quantity)
          throw new ConflictException('Checkout selection differs from cart');
        if (!item.canCheckout) throw new ConflictException({ message: item.message, reasons: item.reasons });
        if (
          !item.offerUuid ||
          !item.productUuid ||
          !item.variantUuid ||
          item.productName === null ||
          item.variantName === null ||
          item.price === null ||
          item.subtotal === null ||
          item.price.currencyCode !== cart.currencyCode
        )
          throw new ConflictException('Checkout data is incomplete');

        return {
          recordUuid: item.recordUuid,
          offerUuid: item.offerUuid,
          productUuid: item.productUuid,
          variantUuid: item.variantUuid,
          productName: item.productName,
          variantName: item.variantName,
          article: item.article,
          clarifications: [...item.clarifications],
          imageUuid: item.imageUuid,
          quantity: item.quantity,
          expectedItemVersion: item.version,
          unitPrice: { ...item.price },
          subtotal: item.subtotal,
        };
      });
    if (cart.shop.name === null) throw new ConflictException('Shop data is incomplete');

    return {
      cartUuid: cart.uuid,
      ownerUuid: cart.ownerUuid,
      shop: { uuid: cart.shop.uuid, name: cart.shop.name },
      currencyCode: cart.currencyCode,
      items,
      itemsTotal: sumPrices(items.map((item) => item.subtotal)),
    };
  }
}
