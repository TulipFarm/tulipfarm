-- The running server of a server app. The live columns name the host that serves now; the candidate columns name the
-- host an operation is bringing up to replace it, and are set or cleared together. host_ref is the app host's own
-- name for a host. Stops stay on tf_apps.
CREATE TABLE {{schema}}.tf_app_runtimes (
  app_id uuid PRIMARY KEY REFERENCES {{schema}}.tf_apps(id),
  live_release_id uuid REFERENCES {{schema}}.tf_app_releases(id),
  size_vcpu integer NOT NULL CHECK (size_vcpu > 0),
  size_mem_mib integer NOT NULL CHECK (size_mem_mib > 0),
  host_ref text CHECK (char_length(host_ref) BETWEEN 1 AND 512),
  state text NOT NULL CHECK (state IN ('none','starting','serving','replacing','failed')),
  candidate_operation_id uuid REFERENCES {{schema}}.tf_app_operations(id),
  candidate_release_id uuid REFERENCES {{schema}}.tf_app_releases(id),
  candidate_size_vcpu integer CHECK (candidate_size_vcpu > 0),
  candidate_size_mem_mib integer CHECK (candidate_size_mem_mib > 0),
  candidate_host_ref text CHECK (char_length(candidate_host_ref) BETWEEN 1 AND 512),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT tf_app_runtimes_candidate_check CHECK (num_nonnulls(candidate_operation_id, candidate_release_id,
    candidate_size_vcpu, candidate_size_mem_mib, candidate_host_ref) IN (0, 5))
);
REVOKE ALL ON {{schema}}.tf_app_runtimes FROM PUBLIC;
GRANT SELECT, INSERT ON {{schema}}.tf_app_runtimes TO {{runtime}};
GRANT UPDATE (live_release_id, size_vcpu, size_mem_mib, host_ref, state, candidate_operation_id, candidate_release_id,
  candidate_size_vcpu, candidate_size_mem_mib, candidate_host_ref, updated_at) ON {{schema}}.tf_app_runtimes TO {{runtime}};
