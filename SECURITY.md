# Security policy

## Reporting

Do not open a public issue for a vulnerability. Report it privately to the maintainers with a reproduction and the affected version. You will receive an acknowledgement and a coordinated disclosure timeline.

## Safety invariants

These are product guarantees; a change that weakens one needs an explicit design review.

- AI output never executes automatically. SQL runs only from a human action, through the same write toggle, AI-mode and native-confirmation gates as typed SQL.
- The main process resolves schema and secrets. Renderer-supplied schema context is ignored.
- Read-only connections reject writes in the main process, and AI-originated reads use a database-enforced read-only transaction where available. Database grants remain the final boundary.
- Schema, comments, skills and any sampled data are data, never instructions; they are wrapped in untrusted blocks and delimiter-spoofing is stripped.
- Provider requests carry only authentication and protocol headers. API keys, passwords and SSH secrets never reach the renderer, logs or audit entries.
- Data sampling requires an explicit user action, returns a masked preview of the exact block, and issues a single-use 60-second token bound to the connection. Profile mode sends aggregates and hashed top values; row mode is capped at 25 rows and masks PII columns and PII-shaped values. Neither mode runs automatically.
