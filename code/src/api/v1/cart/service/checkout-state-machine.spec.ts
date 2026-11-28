import { CheckoutEvent } from '../enum/checkout-event.enum';
import { CheckoutStatus } from '../enum/checkout-status.enum';
import { CheckoutStateMachine } from './checkout-state-machine';

describe('Cart checkout FSM', () => {
  const states = new CheckoutStateMachine();

  it.each([
    [null, CheckoutEvent.PREPARE, CheckoutStatus.PREPARED],
    [null, CheckoutEvent.CANCEL, CheckoutStatus.CANCELLED],
    [CheckoutStatus.PREPARED, CheckoutEvent.PREPARE, CheckoutStatus.PREPARED],
    [CheckoutStatus.PREPARED, CheckoutEvent.COMPLETE, CheckoutStatus.COMPLETED],
    [CheckoutStatus.PREPARED, CheckoutEvent.CANCEL, CheckoutStatus.CANCELLED],
    [CheckoutStatus.COMPLETED, CheckoutEvent.PREPARE, CheckoutStatus.COMPLETED],
    [CheckoutStatus.COMPLETED, CheckoutEvent.COMPLETE, CheckoutStatus.COMPLETED],
    [CheckoutStatus.CANCELLED, CheckoutEvent.PREPARE, CheckoutStatus.CANCELLED],
    [CheckoutStatus.CANCELLED, CheckoutEvent.CANCEL, CheckoutStatus.CANCELLED],
  ] as const)('%s + %s → %s', (status, event, expected) => {
    expect(states.transition(status, event)).toBe(expected);
  });

  it.each([
    [null, CheckoutEvent.COMPLETE],
    [CheckoutStatus.COMPLETED, CheckoutEvent.CANCEL],
    [CheckoutStatus.CANCELLED, CheckoutEvent.COMPLETE],
  ] as const)('rejects %s + %s', (status, event) => {
    expect(() => states.transition(status, event)).toThrow('terminal outcome or was not prepared');
  });
});
