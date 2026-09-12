create table sync_assets (
  sha256 text primary key check (length(sha256) = 64 and sha256 not glob '*[^a-f0-9]*'),
  bytes blob not null,
  size_bytes integer not null check (size_bytes between 0 and 104857600),
  check (length(bytes) = size_bytes)
);

create table sync_staged_assets (
  run_id text not null references sync_runs(id),
  sha256 text not null references sync_assets(sha256),
  primary key (run_id, sha256)
);

create table sync_change_assets (
  change_sequence integer not null references sync_changes(sequence),
  sha256 text not null references sync_assets(sha256),
  primary key (change_sequence, sha256)
);

create index sync_change_assets_sha256_idx on sync_change_assets(sha256);

create index sync_staged_assets_sha256_idx on sync_staged_assets(sha256);
