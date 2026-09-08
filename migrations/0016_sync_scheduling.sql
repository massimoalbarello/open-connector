alter table sync_installations add column consecutive_failures integer not null default 0;
alter table sync_installations add column last_error text;
alter table sync_installations add column requires_backfill integer not null default 0;
alter table sync_installations add column bootstrap_receiver_id text;
create table sync_binding_checks (
  connection_id text not null,
  definition_id text not null,
  credential_revision text not null,
  attempt_count integer not null default 0,
  next_attempt_at text not null,
  last_error text,
  primary key(connection_id, definition_id)
);
-- This deployment introduces a global acquisition slot. Fence legacy workers before installing it.
update sync_installations set requires_backfill = 1, state = 'needs_attention', last_error = 'snapshot_interrupted'
  where exists(select 1 from sync_snapshots s where s.installation_id = sync_installations.id and s.state = 'active');
update sync_snapshots set state = 'abandoned', completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') where state = 'active';
update sync_runs set state = 'lease_expired', completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), error_code = 'runtime_upgrade'
  where state = 'running';
create unique index sync_runs_one_active_global_idx on sync_runs((1)) where state = 'running';
