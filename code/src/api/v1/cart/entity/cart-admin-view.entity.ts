import { CartView } from './cart-view.entity';
import { CartAdminMetadata } from './cart-admin-metadata.entity';

export interface CartAdminView extends CartView, CartAdminMetadata {}
