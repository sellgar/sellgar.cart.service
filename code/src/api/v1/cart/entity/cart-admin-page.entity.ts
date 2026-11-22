import { CursorMetaEntity } from '@sellgar/pagination';

import { CartAdminSummary } from './cart-admin-summary.entity';

export interface CartAdminPage {
  items: CartAdminSummary[];
  meta: CursorMetaEntity;
}
