-- Rollback: challenges and proofs may only be dropped while none exist.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM auth.verification_challenges LIMIT 1)
    OR EXISTS (SELECT 1 FROM auth.contact_proofs LIMIT 1)
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'refusing to drop populated auth challenge tables';
  END IF;
END;
$$;

DROP TABLE auth.contact_proofs;
DROP TABLE auth.verification_challenges;
DROP FUNCTION auth.enforce_contact_proof_lifecycle();
DROP FUNCTION auth.enforce_verification_challenge_lifecycle();
