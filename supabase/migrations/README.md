# supabase/migrations

Database migrations for Supabase project **PBS-DESKTOP (`wqomqigjotnkdlheccxl`)**,
applied in filename order:

| File                                        | Contents                                               |
| ------------------------------------------- | ------------------------------------------------------ |
| `20261003000100_core_schema.sql`            | Enums, tables, constraints, indexes                    |
| `20261003000200_functions_and_triggers.sql` | Integrity triggers, state machine, expiry, RLS helpers |
| `20261003000300_rls.sql`                    | Grants, RLS enablement, policies                       |

Every table has RLS enabled. The same files run in the automated tests (PGlite with
`../tests/supabase-shim.sql`, which recreates the bits of Supabase they depend on — never
apply the shim to a real project).

**Applied to the hosted project on 2026-10-03** (`supabase db push`). For new migrations:
`npx supabase db push --dry-run`, then `npx supabase db push`. See
[docs/backend.md](../../docs/backend.md) §13.
