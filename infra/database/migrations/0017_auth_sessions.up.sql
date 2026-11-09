-- Purpose: SPEC-002 ws-a. Session families, access sessions, and rotating refresh tokens (PLAN §9).
-- Only SHA-256 token hashes are stored. The runtime never writes these tables: it calls SECURITY
-- DEFINER commands that lock the family row and apply the PLAN §9.3 rotation and reuse rules.
-- Lock/rewrite risk: new tables, indexes, functions, and triggers only; no existing rows change.
-- Rollback: paired down migration refuses to drop populated tables.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'trayvi_lifecycle_owner') THEN
    RAISE EXCEPTION USING
      ERRCODE = '42704',
      MESSAGE = 'run infra/database/bootstrap/0001_roles.sql before migration 0017';
  END IF;
END;
$$;

CREATE TABLE auth.session_families (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts.accounts (id) ON DELETE RESTRICT,
  installation_commitment bytea NOT NULL,
  factors text[] NOT NULL,
  assurance varchar(8) NOT NULL,
  authenticated_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  last_rotated_at timestamptz NOT NULL,
  idle_expires_at timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  state varchar(16) NOT NULL,
  revoke_reason varchar(32),
  revoked_at timestamptz,
  version integer NOT NULL,
  CONSTRAINT session_family_installation_length CHECK (octet_length(installation_commitment) = 32),
  CONSTRAINT session_family_factors_valid CHECK (
    cardinality(factors) >= 1
    AND factors <@ ARRAY['CONTACT_OTP', 'PASSWORD', 'IDENTITY_REVERIFICATION']::text[]
  ),
  CONSTRAINT session_family_assurance_valid CHECK (assurance IN ('AAL1', 'AAL2')),
  CONSTRAINT session_family_expiry_order CHECK (
    created_at <= idle_expires_at AND created_at < absolute_expires_at
  ),
  CONSTRAINT session_family_state_valid CHECK (state IN ('ACTIVE', 'REVOKED', 'EXPIRED')),
  CONSTRAINT session_family_revoke_reason_valid CHECK (
    revoke_reason IS NULL OR revoke_reason IN (
      'LOGOUT', 'USER_REVOKED', 'REUSE_DETECTED', 'ACCOUNT_STATE', 'RECOVERY', 'CONTACT_CHANGED',
      'PASSWORD_CHANGED', 'SECURITY_POLICY'
    )
  ),
  CONSTRAINT session_family_state_fields CHECK (
    (state = 'ACTIVE' AND revoke_reason IS NULL AND revoked_at IS NULL)
    OR (state = 'REVOKED' AND revoke_reason IS NOT NULL AND revoked_at IS NOT NULL)
    OR (state = 'EXPIRED' AND revoke_reason IS NULL AND revoked_at IS NULL)
  ),
  CONSTRAINT session_family_version_nonnegative CHECK (version >= 0)
);

-- Revocation and listing scan one account's active families.
CREATE INDEX session_family_active_account ON auth.session_families (account_id)
  WHERE state = 'ACTIVE';
-- newInstallation: has this account seen this installation before?
CREATE INDEX session_family_account_installation
  ON auth.session_families (account_id, installation_commitment);

CREATE TABLE auth.sessions (
  id uuid PRIMARY KEY,
  family_id uuid NOT NULL REFERENCES auth.session_families (id) ON DELETE RESTRICT,
  access_token_hash bytea NOT NULL,
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  state varchar(16) NOT NULL,
  CONSTRAINT session_access_token_hash_unique UNIQUE (access_token_hash),
  CONSTRAINT session_access_token_hash_length CHECK (octet_length(access_token_hash) = 32),
  CONSTRAINT session_expiry_order CHECK (issued_at < expires_at),
  CONSTRAINT session_state_valid CHECK (state IN ('ACTIVE', 'REVOKED'))
);

CREATE INDEX session_family ON auth.sessions (family_id);

CREATE TABLE auth.refresh_tokens (
  id uuid PRIMARY KEY,
  family_id uuid NOT NULL REFERENCES auth.session_families (id) ON DELETE RESTRICT,
  predecessor_id uuid REFERENCES auth.refresh_tokens (id) ON DELETE RESTRICT,
  token_hash bytea NOT NULL,
  state varchar(16) NOT NULL,
  issued_at timestamptz NOT NULL,
  rotated_at timestamptz,
  first_used_at timestamptz,
  revoked_at timestamptz,
  CONSTRAINT refresh_token_predecessor_unique UNIQUE (predecessor_id),
  CONSTRAINT refresh_token_hash_unique UNIQUE (token_hash),
  CONSTRAINT refresh_token_hash_length CHECK (octet_length(token_hash) = 32),
  CONSTRAINT refresh_token_state_valid CHECK (state IN ('ISSUED', 'ROTATED', 'REVOKED')),
  CONSTRAINT refresh_token_state_fields CHECK (
    (state = 'ISSUED' AND rotated_at IS NULL AND revoked_at IS NULL)
    OR (state = 'ROTATED' AND rotated_at IS NOT NULL AND revoked_at IS NULL)
    OR (state = 'REVOKED' AND revoked_at IS NOT NULL)
  )
);

-- R-07: at most one ISSUED refresh token per family.
CREATE UNIQUE INDEX refresh_token_one_issued_per_family ON auth.refresh_tokens (family_id)
  WHERE state = 'ISSUED';
CREATE INDEX refresh_token_family ON auth.refresh_tokens (family_id);

-- R-07: terminal families never change; identities, hashes, and issue times are immutable; only
-- the PLAN §9.3 edges are legal.
CREATE FUNCTION auth.enforce_session_family_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'ACTIVE' OR NEW.version <> 0 THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'invalid initial session family state', CONSTRAINT = 'session_family_lifecycle';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.state <> 'ACTIVE' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'terminal session family changed', CONSTRAINT = 'session_family_terminal';
  END IF;
  IF (OLD.id, OLD.account_id, OLD.installation_commitment, OLD.created_at, OLD.absolute_expires_at)
    IS DISTINCT FROM
     (NEW.id, NEW.account_id, NEW.installation_commitment, NEW.created_at, NEW.absolute_expires_at)
    OR NEW.version <> OLD.version + 1
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'immutable session family fields changed', CONSTRAINT = 'session_family_immutable_fields';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION auth.enforce_session_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'ACTIVE' THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'invalid initial session state', CONSTRAINT = 'session_lifecycle';
    END IF;
    RETURN NEW;
  END IF;
  IF (OLD.id, OLD.family_id, OLD.access_token_hash, OLD.issued_at, OLD.expires_at)
    IS DISTINCT FROM
     (NEW.id, NEW.family_id, NEW.access_token_hash, NEW.issued_at, NEW.expires_at)
    OR NOT (OLD.state = 'ACTIVE' AND NEW.state = 'REVOKED')
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'session lifecycle transition denied', CONSTRAINT = 'session_lifecycle';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION auth.enforce_refresh_token_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'ISSUED' OR NEW.first_used_at IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'invalid initial refresh token state', CONSTRAINT = 'refresh_token_lifecycle';
    END IF;
    RETURN NEW;
  END IF;
  IF (OLD.id, OLD.family_id, OLD.predecessor_id, OLD.token_hash, OLD.issued_at)
    IS DISTINCT FROM
     (NEW.id, NEW.family_id, NEW.predecessor_id, NEW.token_hash, NEW.issued_at)
    OR (OLD.first_used_at IS NOT NULL AND NEW.first_used_at IS DISTINCT FROM OLD.first_used_at)
    OR (OLD.rotated_at IS NOT NULL AND NEW.rotated_at IS DISTINCT FROM OLD.rotated_at)
    OR NOT (
      (OLD.state = 'ISSUED' AND NEW.state IN ('ROTATED', 'REVOKED'))
      OR (OLD.state = 'ROTATED' AND NEW.state = 'REVOKED')
    )
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'refresh token lifecycle transition denied', CONSTRAINT = 'refresh_token_lifecycle';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION auth.reject_session_delete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'session records are not deleted', CONSTRAINT = 'session_records_retained';
END;
$$;

CREATE TRIGGER enforce_session_family_lifecycle
BEFORE INSERT OR UPDATE ON auth.session_families
FOR EACH ROW EXECUTE FUNCTION auth.enforce_session_family_lifecycle();
CREATE TRIGGER enforce_session_lifecycle
BEFORE INSERT OR UPDATE ON auth.sessions
FOR EACH ROW EXECUTE FUNCTION auth.enforce_session_lifecycle();
CREATE TRIGGER enforce_refresh_token_lifecycle
BEFORE INSERT OR UPDATE ON auth.refresh_tokens
FOR EACH ROW EXECUTE FUNCTION auth.enforce_refresh_token_lifecycle();
CREATE TRIGGER reject_session_family_delete
BEFORE DELETE ON auth.session_families
FOR EACH ROW EXECUTE FUNCTION auth.reject_session_delete();
CREATE TRIGGER reject_session_delete
BEFORE DELETE ON auth.sessions
FOR EACH ROW EXECUTE FUNCTION auth.reject_session_delete();
CREATE TRIGGER reject_refresh_token_delete
BEFORE DELETE ON auth.refresh_tokens
FOR EACH ROW EXECUTE FUNCTION auth.reject_session_delete();

-- Revokes one locked family with every live session and token. Never granted to a login.
CREATE FUNCTION auth.revoke_locked_family(p_family_id uuid, p_reason varchar, p_at timestamptz)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  UPDATE auth.session_families
  SET state = 'REVOKED', revoke_reason = p_reason, revoked_at = p_at, version = version + 1
  WHERE id = p_family_id AND state = 'ACTIVE';
  UPDATE auth.sessions SET state = 'REVOKED' WHERE family_id = p_family_id AND state = 'ACTIVE';
  UPDATE auth.refresh_tokens SET state = 'REVOKED', revoked_at = p_at
  WHERE family_id = p_family_id AND state IN ('ISSUED', 'ROTATED');
END;
$$;

-- R-02: one ACTIVE family, one session, and one ISSUED refresh token. Returns whether the account
-- had never used this installation before (drives the new-session security notice).
CREATE FUNCTION auth.issue_session_family(
  p_family_id uuid,
  p_session_id uuid,
  p_refresh_id uuid,
  p_account_id uuid,
  p_installation_commitment bytea,
  p_factors text[],
  p_assurance varchar,
  p_authenticated_at timestamptz,
  p_access_token_hash bytea,
  p_access_expires_at timestamptz,
  p_refresh_token_hash bytea,
  p_idle_expires_at timestamptz,
  p_absolute_expires_at timestamptz,
  p_at timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  account_status varchar;
  seen boolean;
BEGIN
  SELECT account.status INTO account_status
  FROM accounts.accounts account
  WHERE account.id = p_account_id
  FOR SHARE;
  IF NOT FOUND OR account_status IN ('SUSPENDED', 'CLOSED') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'SESSION_ACCOUNT_NOT_ELIGIBLE';
  END IF;
  SELECT EXISTS (
    SELECT 1 FROM auth.session_families family
    WHERE family.account_id = p_account_id
      AND family.installation_commitment = p_installation_commitment
  ) INTO seen;
  INSERT INTO auth.session_families (
    id, account_id, installation_commitment, factors, assurance, authenticated_at, created_at,
    last_rotated_at, idle_expires_at, absolute_expires_at, state, version
  ) VALUES (
    p_family_id, p_account_id, p_installation_commitment, p_factors, p_assurance,
    p_authenticated_at, p_at, p_at, p_idle_expires_at, p_absolute_expires_at, 'ACTIVE', 0
  );
  INSERT INTO auth.sessions (id, family_id, access_token_hash, issued_at, expires_at, state)
  VALUES (p_session_id, p_family_id, p_access_token_hash, p_at, p_access_expires_at, 'ACTIVE');
  INSERT INTO auth.refresh_tokens (id, family_id, predecessor_id, token_hash, state, issued_at)
  VALUES (p_refresh_id, p_family_id, NULL, p_refresh_token_hash, 'ISSUED', p_at);
  RETURN NOT seen;
END;
$$;

-- R-04-R-06, PLAN §9.3. Locks the family row, then decides:
--   ROTATED         an ISSUED token from the family's installation: rotate it, extend idle expiry.
--   GRACE_ROTATED   the immediate predecessor of an unused ISSUED successor, rotated at most
--                   p_grace_seconds ago, from the same installation: revoke the successor and
--                   issue a fresh one; the family stays ACTIVE.
--   REUSE_DETECTED  any other presentation of a known token of an ACTIVE family: revoke it.
--   ACCOUNT_STATE   the account is SUSPENDED or CLOSED: revoke the family.
--   EXPIRED         the family passed its idle or absolute expiry: mark it EXPIRED.
--   INVALID         unknown token, or a family that is already terminal.
CREATE FUNCTION auth.rotate_refresh_token(
  p_token_hash bytea,
  p_installation_commitment bytea,
  p_at timestamptz,
  p_grace_seconds integer,
  p_idle_seconds integer,
  p_session_id uuid,
  p_access_token_hash bytea,
  p_access_expires_at timestamptz,
  p_refresh_id uuid,
  p_refresh_token_hash bytea
)
RETURNS TABLE (
  outcome text,
  family_id uuid,
  account_id uuid,
  family_expires_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  token_row auth.refresh_tokens%ROWTYPE;
  family_row auth.session_families%ROWTYPE;
  successor auth.refresh_tokens%ROWTYPE;
  account_status varchar;
  next_idle timestamptz;
BEGIN
  IF p_grace_seconds NOT BETWEEN 0 AND 60 OR p_idle_seconds < 1 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'SESSION_POLICY_INVALID';
  END IF;

  SELECT * INTO token_row FROM auth.refresh_tokens token WHERE token.token_hash = p_token_hash;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'INVALID'::text, NULL::uuid, NULL::uuid, NULL::timestamptz;
    RETURN;
  END IF;

  SELECT * INTO family_row FROM auth.session_families family
  WHERE family.id = token_row.family_id
  FOR UPDATE;
  IF family_row.state <> 'ACTIVE' THEN
    RETURN QUERY SELECT 'INVALID'::text, family_row.id, family_row.account_id, NULL::timestamptz;
    RETURN;
  END IF;
  -- Re-read under the family lock: a concurrent rotation may have changed the token.
  SELECT * INTO token_row FROM auth.refresh_tokens token WHERE token.id = token_row.id;

  SELECT account.status INTO account_status
  FROM accounts.accounts account
  WHERE account.id = family_row.account_id
  FOR SHARE;
  IF account_status IN ('SUSPENDED', 'CLOSED') THEN
    PERFORM auth.revoke_locked_family(family_row.id, 'ACCOUNT_STATE', p_at);
    RETURN QUERY SELECT 'ACCOUNT_STATE'::text, family_row.id, family_row.account_id, NULL::timestamptz;
    RETURN;
  END IF;

  IF family_row.idle_expires_at <= p_at OR family_row.absolute_expires_at <= p_at THEN
    UPDATE auth.session_families SET state = 'EXPIRED', version = version + 1
    WHERE id = family_row.id;
    UPDATE auth.sessions SET state = 'REVOKED' WHERE auth.sessions.family_id = family_row.id
      AND state = 'ACTIVE';
    UPDATE auth.refresh_tokens SET state = 'REVOKED', revoked_at = p_at
    WHERE auth.refresh_tokens.family_id = family_row.id AND state IN ('ISSUED', 'ROTATED');
    RETURN QUERY SELECT 'EXPIRED'::text, family_row.id, family_row.account_id, NULL::timestamptz;
    RETURN;
  END IF;

  IF token_row.state = 'ISSUED'
    AND family_row.installation_commitment = p_installation_commitment
  THEN
    UPDATE auth.refresh_tokens
    SET state = 'ROTATED', rotated_at = p_at, first_used_at = COALESCE(first_used_at, p_at)
    WHERE id = token_row.id;
    outcome := 'ROTATED';
  ELSIF token_row.state = 'ROTATED'
    AND family_row.installation_commitment = p_installation_commitment
    AND token_row.rotated_at >= p_at - make_interval(secs => p_grace_seconds)
  THEN
    SELECT * INTO successor FROM auth.refresh_tokens token
    WHERE token.predecessor_id = token_row.id;
    IF NOT FOUND OR successor.state <> 'ISSUED' OR successor.first_used_at IS NOT NULL THEN
      PERFORM auth.revoke_locked_family(family_row.id, 'REUSE_DETECTED', p_at);
      RETURN QUERY SELECT 'REUSE_DETECTED'::text, family_row.id, family_row.account_id, NULL::timestamptz;
      RETURN;
    END IF;
    UPDATE auth.refresh_tokens SET state = 'REVOKED', revoked_at = p_at WHERE id = successor.id;
    -- The fresh token follows the revoked successor, so predecessor links stay unique.
    token_row := successor;
    outcome := 'GRACE_ROTATED';
  ELSE
    PERFORM auth.revoke_locked_family(family_row.id, 'REUSE_DETECTED', p_at);
    RETURN QUERY SELECT 'REUSE_DETECTED'::text, family_row.id, family_row.account_id, NULL::timestamptz;
    RETURN;
  END IF;

  next_idle := LEAST(p_at + make_interval(secs => p_idle_seconds), family_row.absolute_expires_at);
  UPDATE auth.session_families
  SET idle_expires_at = GREATEST(idle_expires_at, next_idle), last_rotated_at = p_at,
      version = version + 1
  WHERE id = family_row.id
  RETURNING idle_expires_at INTO next_idle;
  INSERT INTO auth.sessions (id, family_id, access_token_hash, issued_at, expires_at, state)
  VALUES (p_session_id, family_row.id, p_access_token_hash, p_at, p_access_expires_at, 'ACTIVE');
  INSERT INTO auth.refresh_tokens (id, family_id, predecessor_id, token_hash, state, issued_at)
  VALUES (p_refresh_id, family_row.id, token_row.id, p_refresh_token_hash, 'ISSUED', p_at);
  RETURN QUERY SELECT outcome, family_row.id, family_row.account_id,
    LEAST(next_idle, family_row.absolute_expires_at);
END;
$$;

-- R-09, R-10: revokes one family (p_family_id), or every ACTIVE family of the account except
-- p_except_family_id. Runs in the caller's transaction; locks families in id order.
CREATE FUNCTION auth.revoke_session_families(
  p_account_id uuid,
  p_family_id uuid,
  p_except_family_id uuid,
  p_reason varchar,
  p_at timestamptz
)
RETURNS TABLE (family_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  target uuid;
BEGIN
  IF p_reason NOT IN (
    'LOGOUT', 'USER_REVOKED', 'ACCOUNT_STATE', 'RECOVERY', 'CONTACT_CHANGED', 'PASSWORD_CHANGED',
    'SECURITY_POLICY'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'SESSION_REVOKE_REASON_INVALID';
  END IF;
  FOR target IN
    SELECT family.id FROM auth.session_families family
    WHERE family.account_id = p_account_id
      AND family.state = 'ACTIVE'
      AND (p_family_id IS NULL OR family.id = p_family_id)
      AND (p_except_family_id IS NULL OR family.id <> p_except_family_id)
    ORDER BY family.id
    FOR UPDATE
  LOOP
    PERFORM auth.revoke_locked_family(target, p_reason, p_at);
    family_id := target;
    RETURN NEXT;
  END LOOP;
END;
$$;

-- R-24: a completed step-up refreshes authenticated-at and adds the factor, on the same family.
CREATE FUNCTION auth.record_step_up(p_family_id uuid, p_factor varchar, p_at timestamptz)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  current_factors text[];
BEGIN
  IF p_factor NOT IN ('CONTACT_OTP', 'PASSWORD', 'IDENTITY_REVERIFICATION') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'SESSION_FACTOR_INVALID';
  END IF;
  SELECT family.factors INTO current_factors
  FROM auth.session_families family
  WHERE family.id = p_family_id AND family.state = 'ACTIVE'
    AND family.idle_expires_at > p_at AND family.absolute_expires_at > p_at
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  UPDATE auth.session_families
  SET authenticated_at = GREATEST(authenticated_at, p_at),
      factors = CASE WHEN p_factor = ANY (current_factors) THEN current_factors
                     ELSE current_factors || p_factor::text END,
      assurance = CASE
        WHEN 'CONTACT_OTP' = ANY (current_factors || p_factor::text)
          AND 'PASSWORD' = ANY (current_factors || p_factor::text) THEN 'AAL2'
        ELSE assurance END,
      version = version + 1
  WHERE id = p_family_id;
  RETURN true;
END;
$$;

-- R-03: resolves an access-token hash only for an ACTIVE, unexpired session of an ACTIVE,
-- unexpired family. Every other case returns no row, so callers cannot tell causes apart.
CREATE FUNCTION auth.resolve_access_token(p_access_token_hash bytea, p_at timestamptz)
RETURNS TABLE (
  account_id uuid,
  session_id uuid,
  family_id uuid,
  authenticated_at timestamptz,
  assurance varchar,
  factors text[]
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT family.account_id, session.id, family.id, family.authenticated_at, family.assurance,
         family.factors
  FROM auth.sessions session
  JOIN auth.session_families family ON family.id = session.family_id
  WHERE session.access_token_hash = p_access_token_hash
    AND session.state = 'ACTIVE'
    AND session.expires_at > p_at
    AND family.state = 'ACTIVE'
    AND family.idle_expires_at > p_at
    AND family.absolute_expires_at > p_at;
$$;

-- Command owner privileges.
GRANT SELECT, INSERT ON TABLE auth.session_families TO trayvi_lifecycle_owner;
GRANT UPDATE (factors, assurance, authenticated_at, last_rotated_at, idle_expires_at, state,
  revoke_reason, revoked_at, version) ON TABLE auth.session_families TO trayvi_lifecycle_owner;
GRANT SELECT, INSERT ON TABLE auth.sessions TO trayvi_lifecycle_owner;
GRANT UPDATE (state) ON TABLE auth.sessions TO trayvi_lifecycle_owner;
GRANT SELECT, INSERT ON TABLE auth.refresh_tokens TO trayvi_lifecycle_owner;
GRANT UPDATE (state, rotated_at, first_used_at, revoked_at) ON TABLE auth.refresh_tokens
  TO trayvi_lifecycle_owner;
-- accounts.accounts reads (FOR SHARE) rely on the command-owner grants from migration 0008.

-- Ownership and execute rights. Trigger functions keep the default owner; commands move to the
-- non-login command owner.
REVOKE ALL ON FUNCTION auth.enforce_session_family_lifecycle() FROM PUBLIC;
REVOKE ALL ON FUNCTION auth.enforce_session_lifecycle() FROM PUBLIC;
REVOKE ALL ON FUNCTION auth.enforce_refresh_token_lifecycle() FROM PUBLIC;
REVOKE ALL ON FUNCTION auth.reject_session_delete() FROM PUBLIC;
REVOKE ALL ON FUNCTION auth.revoke_locked_family(uuid, varchar, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth.issue_session_family(
  uuid, uuid, uuid, uuid, bytea, text[], varchar, timestamptz, bytea, timestamptz, bytea,
  timestamptz, timestamptz, timestamptz
) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth.rotate_refresh_token(
  bytea, bytea, timestamptz, integer, integer, uuid, bytea, timestamptz, uuid, bytea
) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth.revoke_session_families(uuid, uuid, uuid, varchar, timestamptz)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION auth.record_step_up(uuid, varchar, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth.resolve_access_token(bytea, timestamptz) FROM PUBLIC;
ALTER FUNCTION auth.revoke_locked_family(uuid, varchar, timestamptz)
  OWNER TO trayvi_lifecycle_owner;
ALTER FUNCTION auth.issue_session_family(
  uuid, uuid, uuid, uuid, bytea, text[], varchar, timestamptz, bytea, timestamptz, bytea,
  timestamptz, timestamptz, timestamptz
) OWNER TO trayvi_lifecycle_owner;
ALTER FUNCTION auth.rotate_refresh_token(
  bytea, bytea, timestamptz, integer, integer, uuid, bytea, timestamptz, uuid, bytea
) OWNER TO trayvi_lifecycle_owner;
ALTER FUNCTION auth.revoke_session_families(uuid, uuid, uuid, varchar, timestamptz)
  OWNER TO trayvi_lifecycle_owner;
ALTER FUNCTION auth.record_step_up(uuid, varchar, timestamptz) OWNER TO trayvi_lifecycle_owner;
ALTER FUNCTION auth.resolve_access_token(bytea, timestamptz) OWNER TO trayvi_lifecycle_owner;

-- Runtime: reads of non-hash columns, the commands, and the access-token resolver. No direct
-- INSERT, UPDATE, or DELETE on any session table.
REVOKE ALL ON TABLE auth.session_families, auth.sessions, auth.refresh_tokens FROM PUBLIC;
GRANT SELECT (id, account_id, factors, assurance, authenticated_at, created_at, last_rotated_at,
  idle_expires_at, absolute_expires_at, state, revoke_reason, revoked_at, version)
  ON TABLE auth.session_families TO trayvi_runtime;
GRANT SELECT (id, family_id, issued_at, expires_at, state) ON TABLE auth.sessions TO trayvi_runtime;
GRANT SELECT (id, family_id, predecessor_id, state, issued_at, rotated_at, first_used_at,
  revoked_at) ON TABLE auth.refresh_tokens TO trayvi_runtime;
GRANT EXECUTE ON FUNCTION auth.issue_session_family(
  uuid, uuid, uuid, uuid, bytea, text[], varchar, timestamptz, bytea, timestamptz, bytea,
  timestamptz, timestamptz, timestamptz
) TO trayvi_runtime;
GRANT EXECUTE ON FUNCTION auth.rotate_refresh_token(
  bytea, bytea, timestamptz, integer, integer, uuid, bytea, timestamptz, uuid, bytea
) TO trayvi_runtime;
GRANT EXECUTE ON FUNCTION auth.revoke_session_families(uuid, uuid, uuid, varchar, timestamptz)
  TO trayvi_runtime;
GRANT EXECUTE ON FUNCTION auth.record_step_up(uuid, varchar, timestamptz) TO trayvi_runtime;
GRANT EXECUTE ON FUNCTION auth.resolve_access_token(bytea, timestamptz) TO trayvi_runtime;
