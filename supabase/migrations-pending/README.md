# Pending migrations

Migrations that are prepared but not yet applied live here, deliberately
**outside** `supabase/migrations/`, so `supabase db push` cannot apply them by
accident. Each one needs an explicit decision, a dry run against the verified
project and a rollback plan.

There are none at the moment.

## History

| Migration                   | Prepared   | Applied to PBS-DESKTOP (`wqomqigjotnkdlheccxl`)                                                                |
| --------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------- |
| `20261008000100_fk_indexes` | 2026-10-08 | 2026-10-08, after a dry run and approval. Now in `supabase/migrations/`.                                       |
| `20261008000200_api_role`   | 2026-10-08 | 2026-10-08, same. Password set on 2026-10-08 (SCRAM verifier only); the services now connect as `kestrel_api`. |

## Services switched to `kestrel_api` (done 2026-10-08)

1. Set the password in the SQL editor (never in a migration):
   `alter role kestrel_api password '<generated, 32+ chars>';`
2. Change `DATABASE_URL` to user `kestrel_api.<project-ref>` on the session
   pooler, restart API and signaling, check `/health/ready`, a login, a
   connection and a logout.
3. Rollback: put the `postgres` URL back and restart.
