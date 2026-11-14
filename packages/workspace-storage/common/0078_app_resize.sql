-- A resize keeps the live release and moves a server app to a new size. host_ref names the host a server operation
-- brought up, so a host left behind by a superseded or failed operation can still be found and removed.
ALTER TABLE {{schema}}.tf_app_operations
  DROP CONSTRAINT tf_app_operations_kind_check,
  ADD CONSTRAINT tf_app_operations_kind_check
    CHECK (kind IN ('publish','rollback','pause','resume','disable','enable','rename','resize')),
  ADD COLUMN target_size_vcpu integer CHECK (target_size_vcpu > 0),
  ADD COLUMN target_size_mem_mib integer CHECK (target_size_mem_mib > 0),
  ADD COLUMN host_ref text CHECK (char_length(host_ref) BETWEEN 1 AND 512),
  ADD CONSTRAINT tf_app_operations_target_size_check CHECK (
    num_nonnulls(target_size_vcpu, target_size_mem_mib) = CASE WHEN kind = 'resize' THEN 2 ELSE 0 END
  );
GRANT UPDATE (host_ref) ON {{schema}}.tf_app_operations TO {{runtime}};
