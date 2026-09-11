-- Rollback: Phase 1 core tables may only be removed from an empty/fresh environment.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM accounts.account_creation_operations LIMIT 1)
    OR EXISTS (SELECT 1 FROM accounts.accounts LIMIT 1)
    OR EXISTS (SELECT 1 FROM accounts.account_status_transitions LIMIT 1)
    OR EXISTS (SELECT 1 FROM identity.person_identities LIMIT 1)
    OR EXISTS (SELECT 1 FROM identity.identity_status_transitions LIMIT 1)
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'refusing to remove populated Phase 1 account/identity core';
  END IF;
END;
$$;

REVOKE ALL ON ALL TABLES IN SCHEMA accounts, identity FROM trayvi_runtime;
REVOKE ALL ON SCHEMA accounts, identity FROM trayvi_runtime;
REVOKE ALL ON SCHEMA accounts, identity FROM trayvi_migrator;

DROP TABLE identity.identity_status_transitions;
DROP TABLE identity.person_identities;
DROP TABLE accounts.account_status_transitions;
DROP TABLE accounts.account_creation_operations;
DROP TABLE accounts.accounts;
DROP SCHEMA identity;
DROP SCHEMA accounts;
