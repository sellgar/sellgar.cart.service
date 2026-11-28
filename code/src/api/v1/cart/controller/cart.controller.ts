import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';

import { CartCheckoutService } from '../service/cart-checkout.service';
import { CartCheckoutQueryService } from '../service/cart-checkout-query.service';
import { CartService } from '../service/cart.service';
import { CartCheckoutDto } from './dto/cart-checkout.dto';
import { GetCartCheckoutDto } from './dto/get-cart-checkout.dto';
import { PrepareCartDto } from './dto/prepare-cart.dto';
import { PreviewCartDto } from './dto/preview-cart.dto';
import { AddCartItemDto } from './dto/add-cart-item.dto';
import { CartScopeDto } from './dto/cart-scope.dto';
import { CloseOwnerDto } from './dto/close-owner.dto';
import { RemoveCartItemDto } from './dto/remove-cart-item.dto';
import { SetCartItemDto } from './dto/set-cart-item.dto';

@Controller()
export class CartController {
  constructor(
    private readonly carts: CartService,
    private readonly checkouts: CartCheckoutService,
    private readonly checkoutQueries: CartCheckoutQueryService,
  ) {}

  @MessagePattern({ cmd: 'cart.get' })
  get(@Payload() dto: CartScopeDto) {
    return this.carts.get(dto);
  }

  @MessagePattern({ cmd: 'cart.item.add' })
  add(@Payload() dto: AddCartItemDto) {
    return this.carts.add(dto);
  }

  @MessagePattern({ cmd: 'cart.item.setQuantity' })
  set(@Payload() dto: SetCartItemDto) {
    return this.carts.setQuantity(dto);
  }

  @MessagePattern({ cmd: 'cart.item.remove' })
  remove(@Payload() dto: RemoveCartItemDto) {
    return this.carts.remove(dto);
  }

  @MessagePattern({ cmd: 'cart.owner.close' })
  close(@Payload() dto: CloseOwnerDto) {
    return this.carts.closeOwner(dto);
  }

  @MessagePattern({ cmd: 'cart.checkout.prepare' })
  prepare(@Payload() dto: PrepareCartDto) {
    return this.checkouts.prepare(dto);
  }

  @MessagePattern({ cmd: 'cart.checkout.preview' })
  preview(@Payload() dto: PreviewCartDto) {
    return this.checkoutQueries.preview(dto);
  }

  @MessagePattern({ cmd: 'cart.checkout.get' })
  checkout(@Payload() dto: GetCartCheckoutDto) {
    return this.checkoutQueries.get(dto);
  }

  @MessagePattern({ cmd: 'cart.checkout.cancel' })
  cancel(@Payload() dto: CartCheckoutDto) {
    return this.checkouts.cancel(dto);
  }

  @MessagePattern({ cmd: 'cart.health' })
  health() {
    return { service: 'cart_srv', status: 'ok' };
  }
}
