create table sync_sources (
  id text primary key,
  provider text not null,
  account_id text not null,
  authorization_boundary text not null,
  created_at text not null,
  unique (provider, account_id, authorization_boundary)
);
create table sync_binding_state (id integer primary key check (id = 1), revision integer not null);
insert into sync_binding_state values (1, 0);

create table if not exists sync_installations (
  id text primary key,
  definition_id text not null,
  definition_version text not null,
  provider text not null,
  connection_id text not null,
  source_id text not null references sync_sources(id),
  credential_revision text not null,
  binding_revision integer not null,
  config_value text not null,
  consecutive_failures integer not null default 0,
  last_error text,
  requires_backfill integer not null default 0,
  bootstrap_receiver_id text,
  state text not null check (state in ('enabled', 'disabled', 'needs_attention')),
  schedule_seconds integer check (schedule_seconds is null or schedule_seconds > 0),
  next_due_at text,
  last_success_at text,
  created_at text not null,
  updated_at text not null
);

create index if not exists sync_installations_due_idx
  on sync_installations (state, next_due_at, id);
create index if not exists sync_installations_connection_idx
  on sync_installations (connection_id, definition_id);

create table if not exists sync_runs (
  id text primary key,
  installation_id text not null,
  definition_version text not null,
  reason text not null check (reason in ('schedule', 'manual', 'backfill', 'webhook', 'reconcile', 'retry')),
  state text not null check (state in ('running', 'succeeded', 'failed', 'cancelled', 'lease_expired')),
  lease_owner text not null,
  lease_generation integer not null check (lease_generation > 0),
  lease_expires_at text not null,
  checkpoint_revision integer not null check (checkpoint_revision >= 0),
  binding_revision integer not null,
  page_count integer not null default 0 check (page_count >= 0),
  upsert_count integer not null default 0 check (upsert_count >= 0),
  delete_count integer not null default 0 check (delete_count >= 0),
  change_count integer not null default 0 check (change_count >= 0),
  error_code text,
  error_message text,
  started_at text not null,
  completed_at text
);

create unique index sync_runs_one_active_global_idx on sync_runs((1)) where state = 'running';
create index if not exists sync_runs_installation_started_idx
  on sync_runs (installation_id, started_at desc, id desc);
create index if not exists sync_runs_lease_idx
  on sync_runs (state, lease_expires_at);

create table if not exists sync_checkpoints (
  installation_id text primary key,
  definition_version text not null,
  revision integer not null check (revision > 0),
  value text,
  run_id text not null,
  updated_at text not null
);

create table if not exists sync_changes (
  sequence integer primary key autoincrement,
  event_id text not null unique,
  installation_id text not null,
  provider text not null,
  connection_id text not null,
  definition_id text not null,
  definition_version text not null,
  model text not null,
  record_id text not null,
  operation text not null check (operation in ('added', 'updated', 'deleted')),
  record_revision integer not null check (record_revision > 0),
  payload text not null,
  payload_hash text not null,
  deleted_at text,
  run_id text not null,
  committed_at text not null
);

create index if not exists sync_changes_installation_sequence_idx
  on sync_changes (installation_id, sequence);
create index if not exists sync_changes_record_idx
  on sync_changes (installation_id, model, record_id, sequence);

create table if not exists sync_records (
  installation_id text not null,
  model text not null,
  record_id text not null,
  payload text not null,
  payload_hash text not null,
  revision integer not null check (revision > 0),
  created_sequence integer not null,
  last_change_sequence integer not null,
  first_seen_at text not null,
  last_changed_at text not null,
  deleted_at text,
  last_seen_snapshot_id text,
  primary key (installation_id, model, record_id)
);

create index if not exists sync_records_active_model_idx
  on sync_records (installation_id, model, deleted_at, record_id);
create index if not exists sync_records_snapshot_idx
  on sync_records (installation_id, model, last_seen_snapshot_id, last_change_sequence)
  where deleted_at is null;

create table if not exists sync_snapshots (
  id text primary key,
  installation_id text not null,
  run_id text not null,
  models_value text not null,
  baseline_sequence integer not null check (baseline_sequence >= 0),
  state text not null check (state in ('active', 'completed', 'abandoned')),
  started_at text not null,
  completed_at text
);

create unique index if not exists sync_snapshots_one_active_installation_idx
  on sync_snapshots (installation_id)
  where state = 'active';

create table if not exists sync_sinks (
  id text primary key,
  kind text not null,
  enabled integer not null check (enabled in (0, 1)),
  created_at text not null,
  updated_at text not null
);

create table if not exists sync_outbox (
  sink_id text not null,
  change_sequence integer not null,
  batch_id text references sync_delivery_batches(id),
  state text not null check (state in ('pending', 'leased', 'delivered', 'dead')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  next_attempt_at text not null,
  lease_owner text,
  lease_generation integer not null default 0 check (lease_generation >= 0),
  lease_expires_at text,
  delivered_at text,
  last_error text,
  primary key (sink_id, change_sequence)
);

create index if not exists sync_outbox_due_idx
  on sync_outbox (state, next_attempt_at, sink_id, change_sequence);

create unique index sync_installations_source_definition_idx on sync_installations(source_id, definition_id);
create table sync_source_kinds (
  source_id text not null references sync_sources(id),
  kind text not null,
  installation_id text not null references sync_installations(id),
  primary key (source_id, kind)
);

create table sync_receivers (
  id text primary key references sync_sinks(id),
  url text not null,
  bearer_secret text not null
);
create table sync_delivery_batches (
  id text primary key,
  sink_id text not null references sync_receivers(id),
  state text not null check (state in ('pending', 'leased', 'delivered')),
  attempt_count integer not null default 0,
  next_attempt_at text not null,
  lease_generation integer not null default 0,
  lease_owner text,
  lease_expires_at text,
  created_at text not null,
  delivered_at text,
  last_error text
);
create unique index sync_delivery_one_pending_batch on sync_delivery_batches(sink_id) where state != 'delivered';
create index sync_outbox_batch_idx on sync_outbox(batch_id, change_sequence);
create table sync_delivery_attempts (
  batch_id text not null references sync_delivery_batches(id),
  attempt integer not null,
  started_at text not null,
  completed_at text,
  http_status integer,
  error_code text,
  primary key(batch_id, attempt)
);
-- JSON null in payload columns means payload purged; identity/hash/revision remain.
-- Payload cleanup is performed by the delivery store only after all intended ACKs.
create index sync_outbox_change_idx on sync_outbox(change_sequence, state);
create index sync_changes_retained_idx on sync_changes(sequence) where payload != 'null';
create index sync_records_retained_idx on sync_records(last_change_sequence) where payload != 'null';

create table sync_binding_checks (
  connection_id text not null,
  definition_id text not null,
  credential_revision text not null,
  attempt_count integer not null default 0,
  next_attempt_at text not null,
  last_error text,
  primary key(connection_id, definition_id)
);
