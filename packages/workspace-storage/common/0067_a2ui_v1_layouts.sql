-- Moves stored layouts from A2UI 0.9 to A2UI 1.0, then allows only 1.0. A layout's surface now uses the basic catalog
-- and names TulipFarm's own catalog on each Embed. Bindings become {"@path"}, literal keys that start with @ are escaped
-- as @@, component IDs become identifiers, and components the 1.0 catalog removed or places differently are replaced.
-- Also adds the `layout-action` part: a person's answer to a layout's button, stored with the message it sends.
ALTER TABLE {{schema}}.tf_conversation_parts DROP CONSTRAINT tf_conversation_parts_layout;

CREATE FUNCTION {{schema}}.tf_a2ui_v1_value(value jsonb) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  result jsonb;
  entry record;
BEGIN
  IF jsonb_typeof(value) = 'array' THEN
    SELECT coalesce(jsonb_agg({{schema}}.tf_a2ui_v1_value(item) ORDER BY position), '[]'::jsonb) INTO result
      FROM jsonb_array_elements(value) WITH ORDINALITY AS items(item, position);
    RETURN result;
  END IF;
  IF jsonb_typeof(value) <> 'object' THEN
    RETURN value;
  END IF;
  IF (SELECT array_agg(key) FROM jsonb_object_keys(value) AS keys(key)) = ARRAY['path'] THEN
    RETURN jsonb_build_object('@path', value->'path');
  END IF;
  result := '{}'::jsonb;
  FOR entry IN SELECT key, item FROM jsonb_each(value) AS entries(key, item) LOOP
    result := result || jsonb_build_object(
      CASE WHEN left(entry.key, 1) = '@' THEN '@' || entry.key ELSE entry.key END,
      {{schema}}.tf_a2ui_v1_value(entry.item)
    );
  END LOOP;
  RETURN result;
END
$$;

CREATE FUNCTION {{schema}}.tf_a2ui_v1_layout(layout jsonb) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  messages jsonb := '[]'::jsonb;
  message jsonb;
  body jsonb;
  components jsonb;
  component jsonb;
  converted jsonb;
  props jsonb;
  renames jsonb := '{}'::jsonb;
  kinds jsonb := '{}'::jsonb;
  parents jsonb := '{"root": "Surface"}'::jsonb;
  used text[] := ARRAY[]::text[];
  original text;
  base text;
  candidate text;
  number integer;
  kind text;
  parent text;
  child jsonb;
BEGIN
  IF layout->>'protocol' IS DISTINCT FROM 'a2ui/0.9' THEN
    RETURN layout;
  END IF;

  -- Every defined component, the last definition winning, as the surface reads them.
  FOR component IN
    SELECT item FROM jsonb_array_elements(layout->'messages') AS sent(entry),
      jsonb_array_elements(coalesce(entry->'createSurface'->'components', entry->'updateComponents'->'components', '[]'::jsonb)) AS items(item)
  LOOP
    kinds := kinds || jsonb_build_object(component->>'id', component->>'component');
  END LOOP;
  SELECT coalesce(array_agg(key), ARRAY[]::text[]) INTO used
    FROM jsonb_object_keys(kinds) AS keys(key) WHERE key ~ '^[A-Za-z_][A-Za-z0-9_]{0,127}$';
  FOR original IN SELECT key FROM jsonb_object_keys(kinds) AS keys(key) ORDER BY key LOOP
    IF original ~ '^[A-Za-z_][A-Za-z0-9_]{0,127}$' THEN
      renames := renames || jsonb_build_object(original, original);
      CONTINUE;
    END IF;
    base := left(regexp_replace(original, '[^A-Za-z0-9_]', '_', 'g'), 120);
    IF base = '' OR base ~ '^[0-9]' THEN
      base := 'c_' || base;
    END IF;
    candidate := base;
    number := 2;
    WHILE candidate = ANY(used) LOOP
      candidate := base || '_' || number;
      number := number + 1;
    END LOOP;
    used := used || candidate;
    renames := renames || jsonb_build_object(original, candidate);
  END LOOP;

  -- The component type of each component's parent, for the 1.0 placement rules.
  FOR component IN
    SELECT item FROM jsonb_array_elements(layout->'messages') AS sent(entry),
      jsonb_array_elements(coalesce(entry->'createSurface'->'components', entry->'updateComponents'->'components', '[]'::jsonb)) AS items(item)
  LOOP
    kind := kinds->>(component->>'id');
    IF component->>'component' IS DISTINCT FROM kind THEN
      CONTINUE;
    END IF;
    IF jsonb_typeof(component->'children') = 'array' THEN
      FOR child IN SELECT item FROM jsonb_array_elements(component->'children') AS items(item) LOOP
        parents := parents || jsonb_build_object(child #>> '{}', kind);
      END LOOP;
    ELSIF jsonb_typeof(component->'children') = 'object' THEN
      parents := parents || jsonb_build_object(component->'children'->>'componentId', kind);
    END IF;
    FOR child IN
      SELECT item->'child' FROM jsonb_array_elements(coalesce(component->'tabs', component->'items', '[]'::jsonb)) AS items(item)
        WHERE kind IN ('Tabs', 'Details')
    LOOP
      parents := parents || jsonb_build_object(child #>> '{}', kind);
    END LOOP;
  END LOOP;

  FOR message IN SELECT item FROM jsonb_array_elements(layout->'messages') AS items(item) LOOP
    IF message ? 'createSurface' THEN
      body := (message->'createSurface') - 'theme' || jsonb_build_object('catalogId', 'sprout/basic@2');
      message := jsonb_build_object('createSurface', body);
    ELSIF message ? 'updateDataModel' THEN
      body := message->'updateDataModel';
      IF NOT body ? 'value' THEN
        body := body || jsonb_build_object('value', NULL);
      END IF;
      message := jsonb_build_object('updateDataModel', body);
    ELSE
      message := message - 'version';
    END IF;

    components := coalesce(message->'createSurface'->'components', message->'updateComponents'->'components');
    IF components IS NOT NULL THEN
      converted := '[]'::jsonb;
      FOR component IN SELECT item FROM jsonb_array_elements(components) AS items(item) LOOP
        kind := component->>'component';
        parent := parents->>(component->>'id');
        props := {{schema}}.tf_a2ui_v1_value(component - 'id' - 'component' - 'children');
        IF jsonb_typeof(component->'children') = 'array' THEN
          SELECT jsonb_build_object('children', coalesce(jsonb_agg(coalesce(renames->(item #>> '{}'), item) ORDER BY position), '[]'::jsonb))
            INTO body FROM jsonb_array_elements(component->'children') WITH ORDINALITY AS items(item, position);
          props := props || body;
        ELSIF jsonb_typeof(component->'children') = 'object' THEN
          props := props || jsonb_build_object('children', component->'children' || jsonb_build_object(
            'componentId', coalesce(renames->(component->'children'->>'componentId'), component->'children'->'componentId')));
        END IF;
        IF kind IN ('Tabs', 'Details') THEN
          SELECT coalesce(jsonb_agg(item || jsonb_build_object('child', coalesce(renames->(item->>'child'), item->'child')) ORDER BY position), '[]'::jsonb)
            INTO body FROM jsonb_array_elements(props->CASE WHEN kind = 'Tabs' THEN 'tabs' ELSE 'items' END) WITH ORDINALITY AS items(item, position);
          props := props || jsonb_build_object(CASE WHEN kind = 'Tabs' THEN 'tabs' ELSE 'items' END, body);
        END IF;
        IF kind IN ('Text', 'Callout') AND jsonb_typeof(props->'text') = 'string' THEN
          props := props || jsonb_build_object('text', regexp_replace(props->>'text', '!\[([^]]*)\]\(', '[\1](', 'g'));
        END IF;

        IF kind = 'Image' THEN
          kind := 'Text';
          props := jsonb_build_object('text', coalesce(nullif(props->>'alt', ''), 'Image'), 'variant', 'caption');
        ELSIF kind = 'Button' THEN
          props := jsonb_build_object('label', props->'label', 'action',
            jsonb_build_object('event', jsonb_build_object('name', 'follow_up', 'userMessage', props->'message')));
        ELSIF kind = 'Embed' THEN
          props := props || jsonb_build_object('@catalogId', 'tulipfarm/chat@2');
        ELSIF kind = 'Section' AND parent NOT IN ('Surface', 'Column', 'Section', 'Tabs', 'Details') THEN
          kind := 'Card';
        ELSIF kind = 'Divider' AND parent NOT IN ('Column', 'Section', 'Card') THEN
          kind := 'Text';
          props := jsonb_build_object('text', '---');
        ELSIF kind = 'Tabs' AND parent NOT IN ('Surface', 'Column', 'Section', 'Card') THEN
          kind := 'Details';
          SELECT jsonb_build_object('items', coalesce(jsonb_agg(jsonb_build_object('title', item->'label', 'child', item->'child') ORDER BY position), '[]'::jsonb))
            INTO props FROM jsonb_array_elements(props->'tabs') WITH ORDINALITY AS items(item, position);
        END IF;
        converted := converted || jsonb_build_array(
          jsonb_build_object('id', coalesce(renames->>(component->>'id'), component->>'id'), 'component', kind) || props
        );
      END LOOP;
      IF message ? 'createSurface' THEN
        message := jsonb_set(message, '{createSurface,components}', converted);
      ELSE
        message := jsonb_set(message, '{updateComponents,components}', converted);
      END IF;
    END IF;
    messages := messages || jsonb_build_array(jsonb_build_object('version', '1.0') || message);
  END LOOP;

  RETURN (layout - 'catalogId') || jsonb_build_object('protocol', 'a2ui/1.0', 'messages', messages);
END
$$;

UPDATE {{schema}}.tf_conversation_parts
  SET layout = {{schema}}.tf_a2ui_v1_layout(layout)
  WHERE layout IS NOT NULL AND layout->>'protocol' = 'a2ui/0.9';

DROP FUNCTION {{schema}}.tf_a2ui_v1_layout(jsonb);
DROP FUNCTION {{schema}}.tf_a2ui_v1_value(jsonb);

ALTER TABLE {{schema}}.tf_conversation_parts
  ADD CONSTRAINT tf_conversation_parts_layout CHECK (
    layout IS NULL OR (
      kind = 'layout'
      AND jsonb_typeof(layout) = 'object'
      AND layout->>'protocol' = 'a2ui/1.0'
      AND layout->>'placement' IN ('chat', 'canvas')
      AND jsonb_typeof(layout->'messages') = 'array'
      AND octet_length(layout::text) <= 262144
    )
  ),
  ADD COLUMN layout_action jsonb,
  ADD CONSTRAINT tf_conversation_parts_layout_action CHECK (
    layout_action IS NULL OR (
      kind = 'layout-action'
      AND jsonb_typeof(layout_action) = 'object'
      AND layout_action ?& ARRAY['messageId', 'name', 'sourceComponentId']
      AND octet_length(layout_action::text) <= 16384
    )
  ),
  DROP CONSTRAINT tf_conversation_parts_kind_check,
  ADD CONSTRAINT tf_conversation_parts_kind_check CHECK ((((kind = 'text'::text) AND (text IS NOT NULL) AND (attachment_id IS NULL) AND (request_id IS NULL) AND (response_id IS NULL) AND (approval_id IS NULL) AND (file_id IS NULL) AND (google_file IS NULL) AND (skill_id IS NULL) AND (compaction_id IS NULL)) OR ((kind = 'attachment'::text) AND (text IS NULL) AND (attachment_id IS NOT NULL) AND (request_id IS NULL) AND (response_id IS NULL) AND (approval_id IS NULL) AND (file_id IS NULL) AND (google_file IS NULL) AND (skill_id IS NULL) AND (compaction_id IS NULL)) OR ((kind = 'request'::text) AND (text IS NULL) AND (attachment_id IS NULL) AND (request_id IS NOT NULL) AND (response_id IS NULL) AND (approval_id IS NULL) AND (file_id IS NULL) AND (google_file IS NULL) AND (skill_id IS NULL) AND (compaction_id IS NULL)) OR ((kind = 'response'::text) AND (text IS NULL) AND (attachment_id IS NULL) AND (request_id IS NULL) AND (response_id IS NOT NULL) AND (approval_id IS NULL) AND (file_id IS NULL) AND (google_file IS NULL) AND (skill_id IS NULL) AND (compaction_id IS NULL)) OR ((kind = ANY (ARRAY['approval'::text, 'approval-resolution'::text])) AND (text IS NULL) AND (attachment_id IS NULL) AND (request_id IS NULL) AND (response_id IS NULL) AND (approval_id IS NOT NULL) AND (file_id IS NULL) AND (google_file IS NULL) AND (skill_id IS NULL) AND (compaction_id IS NULL)) OR ((kind = 'file'::text) AND (text IS NULL) AND (attachment_id IS NULL) AND (request_id IS NULL) AND (response_id IS NULL) AND (approval_id IS NULL) AND (file_id IS NOT NULL) AND (google_file IS NULL) AND (skill_id IS NULL) AND (compaction_id IS NULL)) OR ((kind = 'google-file'::text) AND (text IS NULL) AND (attachment_id IS NULL) AND (request_id IS NULL) AND (response_id IS NULL) AND (approval_id IS NULL) AND (file_id IS NULL) AND (skill_id IS NULL) AND (compaction_id IS NULL) AND (jsonb_typeof(google_file) = 'object'::text) AND (google_file ?& ARRAY['fileId'::text, 'integrationId'::text, 'accountId'::text, 'generation'::text, 'name'::text, 'mimeType'::text]) AND (octet_length((google_file)::text) <= 4096)) OR ((kind = ANY (ARRAY['skill'::text, 'skill-use'::text])) AND (text IS NULL) AND (attachment_id IS NULL) AND (request_id IS NULL) AND (response_id IS NULL) AND (approval_id IS NULL) AND (file_id IS NULL) AND (google_file IS NULL) AND (skill_id IS NOT NULL) AND (compaction_id IS NULL)) OR ((kind = 'compact'::text) AND (attachment_id IS NULL) AND (request_id IS NULL) AND (response_id IS NULL) AND (approval_id IS NULL) AND (file_id IS NULL) AND (google_file IS NULL) AND (skill_id IS NULL) AND ((text IS NULL) OR (compaction_id IS NULL)) AND (char_length(COALESCE(text, 'x'::text)) <= 2000)) OR ((kind = 'compaction'::text) AND (text IS NULL) AND (attachment_id IS NULL) AND (request_id IS NULL) AND (response_id IS NULL) AND (approval_id IS NULL) AND (file_id IS NULL) AND (google_file IS NULL) AND (skill_id IS NULL) AND (compaction_id IS NOT NULL)) OR ((kind = 'layout'::text) AND (text IS NOT NULL) AND (layout IS NOT NULL) AND (attachment_id IS NULL) AND (request_id IS NULL) AND (response_id IS NULL) AND (approval_id IS NULL) AND (file_id IS NULL) AND (google_file IS NULL) AND (skill_id IS NULL) AND (compaction_id IS NULL)) OR ((kind = 'layout-action'::text) AND (text IS NULL) AND (layout IS NULL) AND (layout_action IS NOT NULL) AND (attachment_id IS NULL) AND (request_id IS NULL) AND (response_id IS NULL) AND (approval_id IS NULL) AND (file_id IS NULL) AND (google_file IS NULL) AND (skill_id IS NULL) AND (compaction_id IS NULL))));
