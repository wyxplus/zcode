---
name: brainstorming
description: Clarify an underspecified feature or design decision before implementation. Use when product behavior, ownership or acceptance needs exploration; routine fixes and documentation cleanup follow the existing contract.
---

# Brainstorming Ideas Into Designs

Establish the product behavior and acceptance conditions needed for implementation. Follow the repository's AGENTS.md, current code and the user's already stated decisions and authorization.

## Understand the change

- Search for the existing domain spec, contracts and tests before creating documents.
- Identify the concrete scenario, desired result, state owner and affected interfaces. Distinguish current behavior, agreed changes and unresolved choices.
- Ask concise questions only when their answers change the outcome. Do not make the user reconfirm accepted requirements or routine implementation choices.
- Compare alternatives when a real tradeoff remains. A small change can need only a few sentences; a larger change may need ownership, event order, failure and recovery boundaries.
- Consult the user before implementing an unresolved product rule or a material change of scope. An already authorized implementation does not require repeated design and written-spec approvals.

## Maintain one design entry

Update the existing canonical spec before a behavior change. Keep product rules, ownership, interfaces, acceptance scenarios and confirmed decisions together. Fixing specified behavior needs regression evidence; a pure refactor needs a spec update only when the contract changes.

Create a new spec only for a distinct maintained domain without a suitable entry, or at the user's explicit request. Use the repository's domain convention; do not automatically create dated `docs/superpowers/specs/` files. Keep exploration, mockups and working notes in the conversation or temporary storage unless a durable handoff is needed.

Review the spec for contradictions, ambiguous behavior and scope drift. Mark unimplemented decisions and unverified scenarios explicitly; do not present a proposal as delivered behavior.

## Move to implementation

Use `writing-plans` when dependencies or validation require a coordinated sequence. A separate plan document is optional. Continue authorized work directly; do not automatically commit documents, create a new chat or dispatch subagents.

At completion, merge lasting conclusions into the canonical spec, retain unresolved obligations, remove obsolete process records and update references. Report actual results in the conversation.

## Visual exploration

Use the visual companion only when a visual would help the user assess the design and the user agrees to that tool. Read `visual-companion.md` for its workflow. Text questions and routine code or document changes do not require it.
