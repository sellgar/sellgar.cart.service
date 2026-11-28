import { ConflictException, Injectable } from '@nestjs/common';

import { CheckoutEvent } from '../enum/checkout-event.enum';
import { CheckoutStatus } from '../enum/checkout-status.enum';

@Injectable()
export class CheckoutStateMachine {
  transition(status: CheckoutStatus | null, event: CheckoutEvent): CheckoutStatus {
    switch (event) {
      case CheckoutEvent.PREPARE:
        return status ?? CheckoutStatus.PREPARED;

      case CheckoutEvent.COMPLETE:
        if (status === CheckoutStatus.PREPARED || status === CheckoutStatus.COMPLETED)
          return CheckoutStatus.COMPLETED;
        break;

      case CheckoutEvent.CANCEL:
        if (status !== CheckoutStatus.COMPLETED) return CheckoutStatus.CANCELLED;
        break;
    }

    throw new ConflictException('Checkout has another terminal outcome or was not prepared');
  }
}
