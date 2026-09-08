-- Legacy state has no verified account identity. Preserve it for explicit resolution.
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
alter table sync_installations add column source_id text references sync_sources(id);
alter table sync_installations add column credential_revision text;
alter table sync_installations add column binding_revision integer not null default 0;
create unique index sync_installations_source_definition_idx on sync_installations(source_id, definition_id);
create table sync_source_kinds (
  source_id text not null references sync_sources(id),
  kind text not null,
  installation_id text not null references sync_installations(id),
  primary key (source_id, kind)
);
alter table sync_runs add column binding_revision integer not null default 0;
update sync_installations set state = 'needs_attention' where state = 'enabled';
update sync_runs set state = 'cancelled', error_code = 'source_verification_required',
  error_message = 'Resolve the legacy source identity before resuming.',
  completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') where state = 'running';
update sync_snapshots set state = 'abandoned', completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') where state = 'active';
