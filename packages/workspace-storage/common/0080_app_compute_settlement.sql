-- Server compute for a window settles apart from its traffic, so a host that cannot report an hour does not hold back
-- traffic billing. compute_units stays NULL until the host reports the window, then units grows by it. Rows written
-- before this column charged compute with traffic, so they count as settled.
ALTER TABLE {{schema}}.tf_app_usage_windows ADD COLUMN compute_units numeric(40,0);
UPDATE {{schema}}.tf_app_usage_windows SET compute_units = 0;
CREATE INDEX tf_app_usage_windows_compute_unsettled ON {{schema}}.tf_app_usage_windows (window_start)
  WHERE compute_units IS NULL;
GRANT UPDATE (units, compute_units) ON {{schema}}.tf_app_usage_windows TO {{runtime}};
