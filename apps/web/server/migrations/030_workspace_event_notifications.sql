CREATE OR REPLACE FUNCTION notify_duallane_workspace_event()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM pg_notify('duallane_workspace_events', NEW.space_id);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS workspace_events_notify_insert ON workspace_events;

CREATE TRIGGER workspace_events_notify_insert
AFTER INSERT ON workspace_events
FOR EACH ROW
EXECUTE FUNCTION notify_duallane_workspace_event();
