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
alter table sync_outbox add column batch_id text references sync_delivery_batches(id);
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
-- JSON null in legacy payload columns means payload purged; identity/hash/revision remain.
-- Payload cleanup is performed by the delivery store only after all intended ACKs.
create index sync_outbox_change_idx on sync_outbox(change_sequence, state);
create index sync_changes_retained_idx on sync_changes(sequence) where payload != 'null';
create index sync_records_retained_idx on sync_records(last_change_sequence) where payload != 'null';
