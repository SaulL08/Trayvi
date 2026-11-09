-- Rollback: session tables may only be dropped while no family, session, or refresh token exists.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM auth.session_families LIMIT 1)
    OR EXISTS (SELECT 1 FROM auth.sessions LIMIT 1)
    OR EXISTS (SELECT 1 FROM auth.refresh_tokens LIMIT 1)
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'refusing to drop populated auth session tables';
  END IF;
END;
$$;

DROP FUNCTION auth.resolve_access_token(bytea, timestamptz);
DROP FUNCTION auth.record_step_up(uuid, varchar, timestamptz);
DROP FUNCTION auth.revoke_session_families(uuid, uuid, uuid, varchar, timestamptz);
DROP FUNCTION auth.rotate_refresh_token(
  bytea, bytea, timestamptz, integer, integer, uuid, bytea, timestamptz, uuid, bytea
);
DROP FUNCTION auth.issue_session_family(
  uuid, uuid, uuid, uuid, bytea, text[], varchar, timestamptz, bytea, timestamptz, bytea,
  timestamptz, timestamptz, timestamptz
);
DROP FUNCTION auth.revoke_locked_family(uuid, varchar, timestamptz);
DROP TABLE auth.refresh_tokens;
DROP TABLE auth.sessions;
DROP TABLE auth.session_families;
DROP FUNCTION auth.reject_session_delete();
DROP FUNCTION auth.enforce_refresh_token_lifecycle();
DROP FUNCTION auth.enforce_session_lifecycle();
DROP FUNCTION auth.enforce_session_family_lifecycle();
