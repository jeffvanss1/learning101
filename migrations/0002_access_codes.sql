-- 0002_access_codes.sql — passwordless "access code" identity.
--
-- Every account gets a unique, server-generated access code (shown ONCE at
-- signup — only its hash is stored). Entering the code on any device claims
-- the account, so profiles travel without passwords. NULL = legacy account
-- that predates codes; it is upgraded (code generated) on next login.
--
-- Apply:  npx wrangler d1 migrations apply watchparty-db (--local | --remote)

ALTER TABLE users ADD COLUMN code_hash TEXT;

-- At most one account per code (hashes are 64-hex, collisions impossible in
-- practice; the index also serves the claim lookup).
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_code_hash
  ON users (code_hash) WHERE code_hash IS NOT NULL;
