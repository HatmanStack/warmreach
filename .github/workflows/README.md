# GitHub Actions Workflows

## Inventory

Every workflow in this directory, with what fires it and what it is for. Three are WarmReach Pro only and are absent from the community edition — they are marked, because a table that silently drops rows per edition is how the last inventory went stale.

| Workflow                    | Trigger                                                                   | Purpose                                                                     |
| --------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `ci.yml`                    | push/PR to `main`, ignoring `docs/**` and `*.md`                          | The main gate: lint, typecheck, test, build, and the repo invariant checks   |
| `docs-lint.yml`             | push/PR touching any linted markdown surface or its config                | markdownlint and lychee. **Blocking** in both editions                      |
| `docs-api.yml`              | push/PR touching source, typedoc, or mkdocs config                        | Builds the generated API docs (typedoc + mkdocstrings)                      |
| `doc-consistency.yml`       | push/PR touching the template, shared services, or the two reference docs | Runs `scripts/check-doc-tables.py` — **Pro only**                           |
| `claude.yml`                | `@claude` in an issue, PR comment, or review                              | AI code assistance; gated on `author_association`                           |
| `dependabot-auto-merge.yml` | any Dependabot pull request                                               | Auto-merges non-major dependency bumps                                      |
| `release.yml`               | push to `main` touching `CHANGELOG.md`, or manual dispatch                | Reads the version from the changelog and cuts the GitHub release            |
| `release-sync.yml`          | `workflow_call` from `release.yml`, or manual dispatch                    | Mirrors the release onto the community repo — **Pro only**                  |
| `electron-release.yml`      | `workflow_call` from `release.yml`                                        | Builds and signs the Linux / macOS / Windows desktop clients                |
| `sync-public.yml`           | push to `main` matching the source whitelist                              | Publishes this repository to the community edition — **Pro only**           |

`sync-public.yml` holds a write deploy key and ends in a push, so it is the one workflow whose failure mode is unrecoverable. `scripts/check-sync-leak.sh` runs inside it, against the exact tree it is about to publish.

## Claude Code Action

This repository uses the official [Anthropic Claude Code GitHub Action](https://github.com/anthropics/claude-code-action) for AI-powered code assistance.

### How to Use

Simply mention `@claude` in:
- **Issue comments**
- **Pull request comments**
- **Pull request reviews**
- **New issues** (in title or body)

Claude will respond with code analysis, suggestions, fixes, or implement features based on your request.

### Examples

**In a PR comment:**
```
@claude Review this code for security issues
```

**In an issue:**
```
@claude Implement user authentication using OAuth
```

**In a PR review:**
```
@claude Refactor this function to improve performance
```

### Setup

The workflow requires the `CLAUDE_CODE_OAUTH_TOKEN` secret to be configured in your repository.

If you have Claude Code installed locally, run:
```bash
claude
/install-github-app
```

This will guide you through:
1. Installing the Claude GitHub app
2. Configuring required secrets
3. Setting up repository permissions

### Permissions

The action has the following permissions:
- **Read**: contents, pull-requests, issues, actions (to read CI results)
- **Write**: contents, pull-requests, issues (to respond and make changes)
- **ID token**: For OAuth authentication

### Customization

To customize Claude's behavior, uncomment and modify the optional parameters in `claude.yml`:

```yaml
# Custom prompt (overrides @claude comment)
prompt: 'Review for performance issues'

# Additional configuration
claude_args: '--allowed-tools Bash(gh pr:*)'
```

For more options, see:
- [Usage Documentation](https://github.com/anthropics/claude-code-action/blob/main/docs/usage.md)
- [CLI Reference](https://docs.claude.com/en/docs/claude-code/cli-reference)

### Workflow Triggers

The action runs when:
- ✅ Issue comments containing `@claude` are created
- ✅ PR review comments containing `@claude` are created
- ✅ PR reviews containing `@claude` are submitted
- ✅ Issues mentioning `@claude` are opened or assigned

### Troubleshooting

**Claude not responding?**
- Verify `CLAUDE_CODE_OAUTH_TOKEN` is set in repository secrets
- Check that the Claude GitHub app is installed on your repository
- Ensure workflow permissions are enabled in Settings → Actions → General

**Permission errors?**
- Go to Settings → Actions → General
- Enable "Read and write permissions"
- Allow GitHub Actions to create and approve pull requests

For more help, visit the [Claude Code documentation](https://docs.claude.com/en/docs/claude-code/github-actions).
