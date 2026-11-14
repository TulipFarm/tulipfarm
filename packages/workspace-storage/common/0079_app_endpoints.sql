-- The host the app's endpoint was last switched to and the endpoint generation that switch returned. A switch passes
-- the generation back so it applies only if nothing moved the endpoint since, and the reconcile compares the host with
-- the live one to find an endpoint left on the wrong host.
ALTER TABLE {{schema}}.tf_app_runtimes
  ADD COLUMN endpoint_host_ref text CHECK (char_length(endpoint_host_ref) BETWEEN 1 AND 512),
  ADD COLUMN endpoint_generation bigint CHECK (endpoint_generation >= 0),
  ADD CONSTRAINT tf_app_runtimes_endpoint_check CHECK (num_nonnulls(endpoint_host_ref, endpoint_generation) IN (0, 2));
GRANT UPDATE (endpoint_host_ref, endpoint_generation) ON {{schema}}.tf_app_runtimes TO {{runtime}};
