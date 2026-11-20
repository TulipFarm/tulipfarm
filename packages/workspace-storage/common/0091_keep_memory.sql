-- When the workspace first used Keep for personal memory. Keep then holds every member's memory: if Keep is later
-- turned off, memory is hidden rather than read from tf_personal_memory again. One row at most.
CREATE TABLE {{schema}}.tf_keep_memory (
  id smallint PRIMARY KEY CHECK (id = 1),
  first_used_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
REVOKE ALL ON {{schema}}.tf_keep_memory FROM PUBLIC;
GRANT SELECT, INSERT ON {{schema}}.tf_keep_memory TO {{runtime}};
