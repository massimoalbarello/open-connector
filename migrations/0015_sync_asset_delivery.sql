alter table sync_destination add column assets_url text;
alter table sync_delivery_batches add column body text;
alter table sync_changes add column delivery_hash text;

-- The runtime has one destination. Changing its address or credentials clears these mappings.
create table sync_asset_uploads (
  sha256 text primary key,
  asset_id text not null,
  url text not null,
  size_bytes integer not null
);
