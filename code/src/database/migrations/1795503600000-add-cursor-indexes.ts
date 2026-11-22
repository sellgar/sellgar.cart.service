import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddCursorIndexes1795503600000 implements MigrationInterface {
  name = 'AddCursorIndexes1795503600000';

  async up(runner: QueryRunner): Promise<void> {
    await runner.query('CREATE INDEX carts_cursor_idx ON carts (created_at DESC, uuid ASC)');
    await runner.query(
      'CREATE INDEX carts_owner_cursor_idx ON carts (owner_uuid, created_at DESC, uuid ASC)',
    );
    await runner.query('CREATE INDEX carts_shop_cursor_idx ON carts (shop_uuid, created_at DESC, uuid ASC)');
  }

  async down(): Promise<void> {
    throw new Error('Cursor index rollback is not supported');
  }
}
