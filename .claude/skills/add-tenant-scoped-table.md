---
name: add-tenant-scoped-table
description: Use when adding a new Prisma model to this repo that stores per-tenant data — covers the tenantId/index/RLS conventions every existing tenant-scoped table follows, so the new table doesn't end up as a silent isolation gap.
---

# Adding a new tenant-scoped table in ScriptPay Backend

Every table that holds one tenant's data in this schema follows the same
shape. Skipping a step here means the new table is missing a layer of
tenant isolation that every other table has — not an obvious failure at
review time, since the app-level query still "works."

## 1. Add the model with `tenantId`

```prisma
model YourNewThing {
  id       String @id @default(uuid())
  tenantId String
  tenant   Tenant @relation(fields: [tenantId], references: [id])
  // ... your columns
  createdAt DateTime @default(now())

  @@index([tenantId, createdAt])
  @@map("your_new_things")
}
```

- `tenantId` + the `Tenant` relation is not optional unless the row can
  genuinely predate tenant resolution (the one existing example is
  `WebhookEvent.tenantId`, nullable because a callback isn't matched to a
  tenant until it's processed — that's a deliberate exception, not the
  default).
- Add the reverse relation array on `Tenant` itself
  (`yourNewThings YourNewThing[]`) so the model is discoverable from the
  tenant side, matching every existing relation.
- `@@map(...)` to a `snake_case` table name — every model in this schema
  does this.
- Index at minimum `[tenantId, createdAt]` if the table will ever be listed
  or filtered by tenant (which is almost always) — see `Transaction`'s
  `@@index([tenantId, createdAt])` and `@@index([tenantId, status])` for the
  pattern when there's also a status-like filter column.

## 2. Add the Row-Level Security policy

Prisma does not manage RLS — it's a manual SQL file,
`prisma/manual-sql/001_row_level_security.sql`. Add a block for the new
table in the same shape as the existing ones:

```sql
ALTER TABLE your_new_things ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON your_new_things
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);
```

This is the second, independent layer beneath application-level `tenantId`
filtering (see `docs/security.md`'s "Defense in depth" section) — it exists
specifically so a missed `where: { tenantId }` in a query somewhere doesn't
leak this table's data across tenants. **A new table with no RLS policy is
not protected by this layer until this file is updated and re-applied.**

## 3. Migrate and apply

```bash
npx prisma migrate dev
npm run prisma:generate
psql $DATABASE_URL -f prisma/manual-sql/001_row_level_security.sql
```

The RLS file is idempotent-safe to re-run in full (it's a fixed set of
`ALTER`/`CREATE POLICY` statements) — running the whole file again after
adding one new block is the normal way to apply just that addition; there's
no separate "only run the new part" step.

## 4. Filter every query by tenant anyway

RLS is defense-in-depth, not a replacement for application-level filtering.
Every service method reading/writing this table should still explicitly
scope by `tenantId` — the same as every existing tenant-scoped table's
service does.

## 5. Update the docs

Add the table to `docs/database.md`'s table-by-table reference, following
the existing entries' format (what it stores, notable constraints, why any
non-default choice was made).
