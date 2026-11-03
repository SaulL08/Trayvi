-- Rollback: contact points may only be dropped while no contact point, fingerprint, or transition
-- exists.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM auth.contact_points LIMIT 1)
    OR EXISTS (SELECT 1 FROM auth.contact_point_fingerprints LIMIT 1)
    OR EXISTS (SELECT 1 FROM auth.contact_point_transitions LIMIT 1)
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'refusing to drop populated auth contact point tables';
  END IF;
END;
$$;

DROP FUNCTION auth.active_primary_contact_envelope(uuid);
DROP FUNCTION auth.replace_primary_contact(
  uuid, uuid, uuid, varchar[], bytea[], uuid[], varchar, bytea, bytea, bytea, bytea, varchar, uuid,
  uuid, uuid, uuid, timestamptz, uuid
);
DROP FUNCTION auth.bind_primary_contact(
  uuid, uuid, varchar[], bytea[], uuid[], varchar, bytea, bytea, bytea, bytea, uuid, uuid,
  timestamptz, uuid
);
DROP FUNCTION auth.insert_active_contact(
  uuid, uuid, varchar[], bytea[], uuid[], varchar, bytea, bytea, bytea, bytea, uuid, varchar, uuid,
  timestamptz, uuid
);
DROP TABLE auth.contact_point_transitions;
DROP TABLE auth.contact_point_fingerprints;
DROP TABLE auth.contact_points;
DROP FUNCTION auth.reject_contact_transition_mutation();
DROP FUNCTION auth.enforce_contact_fingerprint_lifecycle();
DROP FUNCTION auth.enforce_contact_point_lifecycle();
REVOKE USAGE ON SCHEMA auth FROM trayvi_lifecycle_owner;
