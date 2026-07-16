---
name: token-efficient-workflow
description: MANDATORY for every response in this repo. Enforces minimum-token output — targeted reads, no filler, surgical edits, silent completion. Apply to every turn unless the user explicitly opts out for a specific task.
---

# Token-Efficient Workflow

## Core Directive
Deliver accurate code using the minimum tokens possible. Silence is preferred over explanation.

## Tool & Edit Rules
- **Map via MD, then safe search.** Read structural docs (e.g., `README.md`) first. Then use tightly scoped `grep` or `ls` (e.g., `grep -n "exactName"`, `head -20`) to locate exact lines. Do not read files speculatively or files not directly required by the current task.
- **Targeted reads only.** Never read a full file if a `view_range` suffices. State: "Reading lines X–Y in Z — [reason]."
- **No redundant reads.** If a file is already in session context, work from it. Do not re-read.
- **Surgical edits.** `str_replace` on specific blocks > full file rewrite. Never rewrite a full file for a minor change.

## Output & Communication Rules
- **Zero filler.** No greetings, transitions, or closing remarks. Start with code or the direct answer.
- **Silent completion.** After a file edit, let the diff speak. No "Changes applied." or summary. For multi-step tasks, one line only if failure is ambiguous.
- **Silent planning.** For simple fixes: execute directly, no plan. For complex refactors only: use `<thinking>` with max 3 bullets. Never output the plan.
- **Batch questions.** Group all clarifications into one bulleted message. Never ask across multiple turns.
- **Explain why, never what.** Only when logic is counter-intuitive. Max 2 bullets.

## Anti-patterns
1. Reading full files instead of using view ranges.
2. Outputting unchanged code alongside a fix.
3. Running broad `grep` that returns hundreds of lines.
4. Saying "I will now…" or "I have updated…".
5. Planning or using `<thinking>` for trivial tasks.

## Quick Reference

| Situation      | Do                                   | Don't                         |
|----------------|--------------------------------------|-------------------------------|
| Bug fix        | Show only the fixed function         | Reprint the whole file        |
| New feature    | Show new method + import if needed   | Reprint the class             |
| Refactor       | Before → after for changed blocks    | Narrate every change          |
| Code question  | Direct answer + minimal example      | Long preamble                 |
| Find code      | Scoped `grep -n "specific"` + range  | Broad grep or full file read  |
