import { MigrationInterface, QueryRunner } from 'typeorm';

export class RenameProductProducer1795400000000 implements MigrationInterface {
  name = 'RenameProductProducer1795400000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query("UPDATE inbox_event SET producer = 'product_srv' WHERE producer = 'product_srv_v2'");
    await queryRunner.query(`
      UPDATE outbox_event
      SET payload = jsonb_set(payload, '{source,producer}', '"product_srv"'::jsonb)
      WHERE payload #>> '{source,producer}' = 'product_srv_v2'
    `);
  }

  async down(): Promise<void> {
    throw new Error('Product producer rename requires a coordinated deployment and cannot be reverted separately');
  }
}
