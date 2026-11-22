export interface CartRow {
  uuid: string;
  owner_uuid: string;
  shop_uuid: string;
  version: string;
  created_at: Date;
  updated_at: Date;
  closed_at: Date | null;
}
