# Bruno API collection

This directory contains the repository-friendly API smoke collection. Set `baseUrl` and
`mockBaseUrl` in `../../environments/local.bru`, then run requests in this order:

1. `01-health.bru`
2. `02-big-aquarium.bru`
3. `03-scenario-common.bru`
4. `04-scenario-rare.bru`
5. `05-scenario-epic.bru`
6. `06-scenario-legendary.bru`
7. `07-list-donations.bru`
8. `08-replay.bru`
9. `09-refund.bru`
10. `10-public-aquarium.bru`
11. `11-personal-aquarium.bru`
12. `12-feed.bru`
13. `13-customize.bru`
14. `14-events.bru`
15. `15-invalid-signature.bru`

The collection deliberately uses stable response field names from `MASTER_SPEC.md`; it never
contains database credentials or webhook secrets.
