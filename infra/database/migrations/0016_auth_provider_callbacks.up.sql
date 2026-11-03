-- Purpose: SPEC-001 ws-d. Receipts for signed provider callbacks (PLAN §14). A receipt unique on
-- (provider alias, kind, provider event ID) makes processing idempotent; only these identifiers and
-- a safe outcome code persist; the raw callback body is never stored. A narrow command records a
-- provider's delivery status on the challenge it refers to (T-D3).
-- Lock/rewrite risk: new table, function, and trigger only.
-- Rollback: paired down migration refuses to drop the table while it holds rows.
CREATE TABLE auth.provider_callback_receipts (
  id uuid PRIMARY KEY,
  provider_alias varchar(32) NOT NULL,
  kind varchar(32) NOT NULL,
  provider_event_id varchar(128) NOT NULL,
  received_at timestamptz NOT NULL,
  outcome_code varchar(32),
  CONSTRAINT provider_callback_alias_format CHECK (provider_alias ~ '^[a-z][a-z0-9-]{0,31}$'),
  CONSTRAINT provider_callback_kind_valid CHECK (kind IN ('delivery-status', 'reverification')),
  CONSTRAINT provider_callback_event_id_format CHECK (provider_event_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  CONSTRAINT provider_callback_outcome_format CHECK (
    outcome_code IS NULL OR outcome_code ~ '^[A-Z][A-Z0-9_]{0,31}$'
  ),
  CONSTRAINT provider_callback_receipt_unique UNIQUE (provider_alias, kind, provider_event_id)
);

-- A receipt records its outcome once; identifiers never change.
CREATE FUNCTION auth.enforce_provider_callback_receipt()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF (OLD.id, OLD.provider_alias, OLD.kind, OLD.provider_event_id, OLD.received_at)
    IS DISTINCT FROM (NEW.id, NEW.provider_alias, NEW.kind, NEW.provider_event_id, NEW.received_at)
    OR OLD.outcome_code IS NOT NULL
    OR NEW.outcome_code IS NULL
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'provider callback receipt is immutable', CONSTRAINT = 'provider_callback_receipt_immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER enforce_provider_callback_receipt
BEFORE UPDATE ON auth.provider_callback_receipts
FOR EACH ROW EXECUTE FUNCTION auth.enforce_provider_callback_receipt();

REVOKE ALL ON FUNCTION auth.enforce_provider_callback_receipt() FROM PUBLIC;
REVOKE ALL ON TABLE auth.provider_callback_receipts FROM PUBLIC;
GRANT SELECT, INSERT ON TABLE auth.provider_callback_receipts TO trayvi_runtime;
GRANT UPDATE (outcome_code) ON TABLE auth.provider_callback_receipts TO trayvi_runtime;

-- T-D3: the delivery-status handler may only move a SENT challenge to DELIVERED or UNDELIVERED. It
-- never overwrites a local failure code and touches no other column.
CREATE FUNCTION auth.record_challenge_delivery_status(
  p_challenge_id uuid,
  p_status varchar,
  p_at timestamptz
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  current_code varchar;
BEGIN
  IF p_status NOT IN ('DELIVERED', 'UNDELIVERED') THEN
    RETURN 'IGNORED_INVALID_STATUS';
  END IF;
  SELECT challenge.delivery_outcome_code INTO current_code
  FROM auth.verification_challenges challenge
  WHERE challenge.id = p_challenge_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'UNKNOWN_REFERENCE';
  END IF;
  IF current_code IS DISTINCT FROM 'SENT' THEN
    RETURN 'IGNORED_NOT_SENT';
  END IF;
  UPDATE auth.verification_challenges
  SET delivery_outcome_code = p_status, updated_at = p_at
  WHERE id = p_challenge_id;
  RETURN 'RECORDED_' || p_status;
END;
$$;

GRANT SELECT (id, delivery_outcome_code) ON TABLE auth.verification_challenges
  TO trayvi_lifecycle_owner;
GRANT UPDATE (delivery_outcome_code, updated_at) ON TABLE auth.verification_challenges
  TO trayvi_lifecycle_owner;
REVOKE ALL ON FUNCTION auth.record_challenge_delivery_status(uuid, varchar, timestamptz) FROM PUBLIC;
ALTER FUNCTION auth.record_challenge_delivery_status(uuid, varchar, timestamptz)
  OWNER TO trayvi_lifecycle_owner;
GRANT EXECUTE ON FUNCTION auth.record_challenge_delivery_status(uuid, varchar, timestamptz)
  TO trayvi_runtime;
