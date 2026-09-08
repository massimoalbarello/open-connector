alter table sync_installations add column removed_at text;
alter table sync_receivers add column removed_at text;
alter table sync_delivery_batches add column cancelled_at text;
drop index sync_delivery_one_pending_batch;
create unique index sync_delivery_one_pending_batch on sync_delivery_batches(sink_id)
  where state != 'delivered' and cancelled_at is null;

-- An outbox entry belongs to the iteration that queued it, which can differ from
-- the change's original run when an explicit backfill hydrates an old revision.
alter table sync_outbox add column run_id text references sync_runs(id);
update sync_outbox set run_id = (select run_id from sync_changes where sequence = change_sequence);
create index sync_outbox_run_idx on sync_outbox(run_id, state);
