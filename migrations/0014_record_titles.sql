-- Retries are rebuilt from durable records using the running envelope version. A v1
-- queue must be acknowledged by the old sender before switching to the strict v2 contract.
create temporary table sync_title_upgrade_guard (pending integer not null);
create temporary trigger require_drained_v1_deliveries
before insert on sync_title_upgrade_guard when new.pending > 0
begin
  select raise(abort, 'Drain pending record deliveries with the v1 sender before upgrading to record delivery v2.');
end;
insert into sync_title_upgrade_guard select count(*) from sync_outbox where state <> 'delivered';
drop table sync_title_upgrade_guard;
