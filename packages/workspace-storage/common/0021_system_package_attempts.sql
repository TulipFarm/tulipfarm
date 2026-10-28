ALTER TABLE {{schema}}.tf_system_package_operations
  ADD COLUMN attempt integer NOT NULL DEFAULT 0 CHECK(attempt >= 0),
  DROP CONSTRAINT tf_system_package_operations_pkey,
  ADD PRIMARY KEY(installation_id,resource_key,attempt,operation);
ALTER TABLE {{schema}}.tf_system_package_reviews
  ADD COLUMN attempt integer NOT NULL DEFAULT 0 CHECK(attempt >= 0),
  DROP CONSTRAINT tf_system_package_reviews_pkey,
  ADD PRIMARY KEY(installation_id,resource_key,attempt);
