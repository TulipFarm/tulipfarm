-- App builds and app hosting are charged in credit units and summarized as their own activities.
ALTER TABLE {{schema}}.tf_credit_usage
  DROP CONSTRAINT tf_credit_usage_activity_check,
  ADD CONSTRAINT tf_credit_usage_activity_check
    CHECK (activity IN ('chat','agent','other','table-search','app-build','app-hosting'));
