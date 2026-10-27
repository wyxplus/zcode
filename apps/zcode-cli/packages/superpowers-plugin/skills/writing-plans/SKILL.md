---
name: writing-plans
description: Plan a multi-step implementation when dependencies, ownership or validation need coordination. Reuse the existing spec and keep ordinary task steps in the conversation.
---

# Writing Plans

Turn the accepted product contract into a bounded implementation sequence. Follow the repository's AGENTS.md and the user's existing authorization.

## Choose the scope and destination

- Read the relevant existing spec, contracts, affected code and available test commands.
- Keep ordinary implementation steps in the conversation or task tracker. Planning does not require a Markdown file, a commit, another approval gate or a new chat.
- If the user requests a saved plan or unfinished cross-session work needs a durable handoff, update the existing spec's implementation/pending section. Create a separate plan only when no suitable entry exists; state its canonical spec, current status, unresolved decisions and closure condition.
- Follow the repository's domain paths. Do not create dated `docs/superpowers/plans/` files by default or split one feature into a spec, plan, review and execution ledger.

## Describe the implementation

Give each task a concrete outcome, owner, affected files, dependency order and observable acceptance condition. Use the current package scripts for verification. Explain state ownership, event order, idempotency and stale-result handling where they affect correctness.

Include code or detailed steps only when they resolve a real ambiguity. Do not copy whole implementations or repeat the spec in the plan. Scale the plan to the change; avoid a task for every minute of work or every routine command.

Before execution, check that the tasks cover the agreed requirements, use consistent contracts and preserve unrelated local changes. Ask only about unresolved decisions that materially change scope; proceed when implementation is already authorized.

## Close the plan

After implementation, update the canonical spec to the delivered behavior. Preserve unfinished requirements and verification limits explicitly, then remove completed or superseded process records and update their references. Use Git for historical details; do not add `archive/` or `completed/` copies.

Report actual validation and remaining limitations in the conversation. Commit, push, delegate or open a new chat only within the user's authorization.
