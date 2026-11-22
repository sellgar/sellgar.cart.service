import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

@Entity('carts')
@Index('carts_cursor_idx', { synchronize: false })
@Index('carts_owner_cursor_idx', { synchronize: false })
@Index('carts_shop_cursor_idx', { synchronize: false })
export class CartModel {
  @PrimaryColumn({ name: 'uuid', type: 'uuid' })
  uuid: string;

  @Column({ name: 'shop_uuid', type: 'uuid' })
  shopUuid: string;

  @Column({ name: 'owner_uuid', type: 'uuid' })
  ownerUuid: string;

  @Column({ name: 'version', type: 'bigint', default: () => '0' })
  version: string;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt: Date;

  @Column({ name: 'updated_at', type: 'timestamptz', default: () => 'now()' })
  updatedAt: Date;

  @Column({ name: 'closed_at', type: 'timestamptz', nullable: true })
  closedAt: Date | null;
}
