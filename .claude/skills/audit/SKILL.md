---
name: audit
description: Run one or more codebase audits (evaluation, health, documentation) sequentially, producing intake docs for a single /pipeline run.
allowed-tools: Agent, Read, Write, Glob, Grep, Bash
---

# Audit

You coordinate one or more codebase audits. Each audit runs sequentially with its own scoping questions and produces an intake doc. All docs land in the same plan directory so a single `/pipeline` command remediates everything.

## Input

`$ARGUMENTS` is optional context — specific concerns, repo path, or which audits to run.

## Process

### Step 1: Select Audits

Ask the user which audits to run:

```
Which audits should I run?

A) All three (health → eval → docs)
B) Code evaluation — 12-pillar scoring across 3 lenses
C) Technical debt — audit across 4 vectors
D) Documentation — drift detection across 6 phases
```

If `$ARGUMENTS` already specifies which audits (e.g., "eval and health"), skip this question.

### Step 2: Generate Plan Identifier

Generate the directory name: `YYYY-MM-DD-audit-slug`
- Date: today's date
- Slug: short name for the repo (e.g., `audit-ragstack`, `audit-my-app`)
- Location: `docs/plans/YYYY-MM-DD-audit-slug/`

Create the directory.

### Step 3: Run Selected Audits Sequentially

Run each selected audit in this order (skip any not selected):

#### 3a: Repo Health (if selected)

Run the repo-health intake flow:

1. Ask repo-health scoping questions (goal, scope, existing tooling, constraints) — **one at a time**, preferring multiple choice
2. **Read** `.claude/skills/pipeline/health-auditor.md` for the role prompt
3. Spawn an **Agent** with the role prompt embedded:

```
<role_prompt>
[Contents of health-auditor.md]
</role_prompt>

<task>
Audit the codebase in the current working directory.
Goal: [from scoping]
Scope: [from scoping]
Existing tooling: [from scoping]
Constraints: [from scoping]
</task>
```

4. Read the agent output. **Write** `docs/plans/YYYY-MM-DD-audit-slug/health-audit.md` with the standard repo-health format (see repo-health/SKILL.md Step 4 for template). Include `type: repo-health` in frontmatter.
5. Report: `Health audit complete. Findings: X critical, Y high, Z medium, W low`

#### 3b: Repo Eval (if selected)

Run the repo-eval intake flow:

1. Ask repo-eval scoping questions (role level, focus areas, context, exclusions, pillar overrides) — **one at a time**, preferring multiple choice
2. **Read** `.claude/skills/pipeline/eval-hire.md`, `.claude/skills/pipeline/eval-stress.md`, `.claude/skills/pipeline/eval-day2.md` for role prompts
3. Spawn **3 Agents in parallel**, each with their role prompt embedded:

```
<role_prompt>
[Contents of eval-{hire|stress|day2}.md]
</role_prompt>

<task>
Evaluate the codebase in the current working directory.
Role level: [from scoping]
Focus areas: [from scoping]
Exclusions: [from scoping]
</task>
```

4. Read all 3 agent outputs. **Write** `docs/plans/YYYY-MM-DD-audit-slug/eval.md` with the standard repo-eval format (see repo-eval/SKILL.md Step 4 for template). Include `type: repo-eval` and `pillar_overrides` in frontmatter.
5. Report: `Evaluation complete. Scores: N/12 pillars at target`

#### 3c: Doc Health (if selected)

Run the doc-health intake flow:

1. Ask doc-health scoping questions (doc scope, constraints, language stack, CI platform, prevention scope) — **one at a time**, preferring multiple choice
2. **Read** `.claude/skills/pipeline/doc-auditor.md` for the role prompt
3. Spawn an **Agent** with the role prompt embedded:

```
<role_prompt>
[Contents of doc-auditor.md]
</role_prompt>

<task>
Audit documentation in the current working directory against codebase reality.
Doc scope: [from scoping]
Constraints: [from scoping]
</task>
```

4. Read the agent output. **Write** `docs/plans/YYYY-MM-DD-audit-slug/doc-audit.md` with the standard doc-health format (see doc-health/SKILL.md Step 4 for template). Include `type: doc-health` in frontmatter.
5. Report: `Doc audit complete. Findings: X drift, Y gaps, Z stale, W broken links`

### Step 4: Handoff

```
Audit complete: docs/plans/YYYY-MM-DD-audit-slug/

Intake docs produced:
- [health-audit.md — X critical, Y high, Z medium, W low]
- [eval.md — N/12 pillars at target]
- [doc-audit.md — X drift, Y gaps, Z stale, W broken links]

To remediate, run:
/pipeline YYYY-MM-DD-audit-slug

The pipeline will run flows in order: health → eval → docs
```

## Rules

- **DO NOT** skip scoping questions for any selected audit
- **DO NOT** run audits in parallel — run them sequentially so scoping questions don't interleave
- **DO NOT** start remediation — your only output is the intake docs
- **DO** embed role prompt contents in agent prompts (agents cannot access skill directory files)
- **DO** produce all intake docs in the same plan directory
- **DO** report results after each audit completes
