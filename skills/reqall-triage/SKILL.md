---
name: reqall-triage
description: Classify an incoming issue or request, gather structured details, de-duplicate, prioritize, and create a Reqall record.
---

# Triage Incoming Issue or Request

## Category Table

| Category | kind | prefix | priority hint |
|---|---|---|---|
| Bug report | issue | BUG: | P0-P2 by impact |
| Feature request | spec or todo | FEAT: | P2-P4 |
| Account/billing | issue | ACCOUNT: | P1-P2 |
| Docs/how-to gap | todo | DOCS: | P3-P4 |
| Integration question | issue | INTEG: | P2-P3 |

Priority scale: P0 critical/security/data loss; P1 high; P2 medium; P3 low; P4 wishlist.

## Steps

1. Resolve project name and call `reqall_upsert_project`.
2. Use the user's description if provided; otherwise ask for it.
3. Classify category and confirm/correct with the user when ambiguous.
4. Gather missing details only:
   - Bug: reproduction, expected/actual, environment, frequency, errors, workaround/severity.
   - Feature: user story, beneficiaries, workaround, desired behavior, acceptance criteria.
   - Account/billing: account context, plan, charge/access issue, urgency.
   - Docs/how-to: goal, what was tried, docs consulted, confusing gap.
   - Integration: service/API, versions, errors, code/config snippets.
5. Search duplicates with `reqall_search`; list open records with `reqall_list_records` filtered by project/kind/status.
6. If duplicate, update the existing record via `reqall_upsert_record` and stop. If related, create a new record and link it.
7. Propose priority and let the user confirm/override when practical.
8. Create the record with `reqall_upsert_record` using title format `{PREFIX} {PRIORITY}: {concise title}` and a structured body.
9. Create related links with `reqall_upsert_link`.
10. Summarize record, priority, links, and suggested next steps.
