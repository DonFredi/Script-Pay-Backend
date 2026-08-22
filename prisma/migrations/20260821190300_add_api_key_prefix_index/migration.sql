-- ApiKeyGuard looks up candidates by keyPrefix on every API-key-authenticated
-- request (before the expensive argon2 verify). That WHERE clause had no
-- supporting index, so every such request forced a sequential scan of the
-- entire api_keys table.
CREATE INDEX "api_keys_keyPrefix_idx" ON "api_keys"("keyPrefix");
