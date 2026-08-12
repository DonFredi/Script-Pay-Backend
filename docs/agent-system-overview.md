# Agent System for ScriptPay

Autonomous agents that maintain and upgrade your payment platform using Claude Code.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                  Agent Dispatcher                       │
│          (scriptpay-agent orchestrates agents)          │
└──────────────────────┬──────────────────────────────────┘
                       │
        ┌──────────────┼──────────────┬──────────────┐
        │              │              │              │
        ▼              ▼              ▼              ▼
   ┌────────┐  ┌────────────┐  ┌──────────┐  ┌──────────┐
   │ Audit  │  │ Security   │  │ Feature  │  │ Quality  │
   │ Agent  │  │ Agent      │  │ Agent    │  │ Agent    │
   └────────┘  └────────────┘  └──────────┘  └──────────┘
        │              │              │              │
        └──────────────┼──────────────┼──────────────┘
                       │
        ┌──────────────┼──────────────┐
        │              │              │
        ▼              ▼              ▼
   ┌──────────┐  ┌──────────┐  ┌──────────┐
   │ Git/Code │  │ Database │  │ Reports  │
   │ Changes  │  │ Queries  │  │ & Logs   │
   └──────────┘  └──────────┘  └──────────┘
```

## Agent Types

### 1. Security Agent

**Runs**: Weekly + on-demand  
**Purpose**: Find and fix security vulnerabilities

- Scans code for OWASP Top 10 issues
- Checks dependencies for CVEs
- Reviews authentication/authorization
- Validates payment security
- Generates security reports
- Creates PR with fixes

**Output**: `security-audit-{date}.md` + Security PRs

### 2. Quality Agent

**Runs**: Daily + on pull requests  
**Purpose**: Improve code quality

- Enforces coding standards
- Reduces complexity
- Eliminates dead code
- Optimizes performance hotspots
- Adds missing tests
- Improves documentation

**Output**: Code cleanup PRs

### 3. Audit Agent

**Runs**: Daily  
**Purpose**: Monitor system health

- Checks for hardcoded secrets
- Validates database queries
- Reviews error handling
- Audits logging practices
- Tracks technical debt
- Generates health report

**Output**: `audit-report-{date}.md` + Issues

### 4. Feature Agent

**Runs**: On-demand + scheduled  
**Purpose**: Generate new features from roadmap

- Reads roadmap from `docs/roadmap.md`
- Generates feature scaffold (API + frontend)
- Creates database migrations
- Writes tests
- Updates documentation
- Creates feature PR for review

**Output**: Feature PRs ready for review

### 5. Test Agent (Planned)

**Runs**: On-demand  
**Purpose**: Improve test coverage

- Analyzes coverage gaps
- Generates unit tests
- Writes integration tests
- Creates E2E test scenarios
- Runs full test suite

**Output**: Test improvement PRs

## Quick Start

### 1. Install Agent CLI

```bash
npm install -g scriptpay-agent
# Or locally:
npm install --save-dev scriptpay-agent
```

### 2. Configure Agents

Create `.claude/agents.json`:

```json
{
  "agents": {
    "security": {
      "enabled": true,
      "schedule": "0 0 * * 0",
      "onPullRequest": true
    },
    "quality": {
      "enabled": true,
      "schedule": "0 2 * * *"
    },
    "audit": {
      "enabled": true,
      "schedule": "0 3 * * *"
    },
    "feature": {
      "enabled": true,
      "manual": true
    }
  }
}
```

### 3. Run Agents

```bash
# Run specific agent
scriptpay-agent run security

# Run all agents
scriptpay-agent run all

# Generate feature from roadmap
scriptpay-agent feature --feature "subscription-support"

# Check system health
scriptpay-agent audit

# View recent runs
scriptpay-agent history
```

## Agent Workflow

Each agent follows this pattern:

```
1. Initialization
   └─ Load configuration
   └─ Authenticate with Git/GitHub
   └─ Create feature branch

2. Analysis
   └─ Scan relevant files
   └─ Identify issues/opportunities
   └─ Generate report

3. Implementation
   └─ Make changes (if applicable)
   └─ Run tests
   └─ Verify fixes

4. Validation
   └─ Run linting/formatting
   └─ Execute tests
   └─ Check compliance

5. Commit & PR
   └─ Commit changes to branch
   └─ Push to remote
   └─ Create pull request
   └─ Add summary & checklist

6. Reporting
   └─ Generate audit trail
   └─ Log changes
   └─ Send notifications
```

## Agent Communication

Agents coordinate via:

1. **Shared Configuration** (`.claude/agents.json`)
2. **Status File** (`.claude/agent-status.json`)
3. **Audit Log** (`.claude/agent-logs/`)
4. **Git Branches** (agent-specific feature branches)

### Example Status File

```json
{
  "lastRun": {
    "security": "2024-01-15T02:00:00Z",
    "quality": "2024-01-15T02:30:00Z",
    "audit": "2024-01-15T03:00:00Z"
  },
  "activeAgents": ["security"],
  "pendingPRs": ["security-fixes-2024-01-15", "quality-improvements-2024-01-15"],
  "issues": []
}
```

## Guard Rails

Agents are constrained to:

### File Scope

- ✅ Can modify: `src/`, `apps/`, `prisma/migrations/`
- ❌ Cannot modify: `.env`, secrets, `package.json` (without approval)

### Git Operations

- Create feature branches only (`agent/*`)
- Create PRs (never auto-merge)
- Cannot force-push or delete branches

### API Operations

- Cannot deploy to production
- Cannot modify infrastructure
- Can create database migrations (reviewed first)

### Approval Requirements

- Security fixes: Auto-commit if test-covered
- Quality improvements: Auto-commit if low-risk
- Feature generation: Always manual PR (requires review)
- Database changes: Always manual PR (requires review)

## Integration with Claude Code

Agents run inside Claude Code via:

```bash
# In Claude Code environment
claude-code $ scriptpay-agent run security

# Agent uses Claude API to:
# - Analyze code
# - Generate fixes
# - Write tests
# - Update docs
```

Agents can call Claude API for:

- Code analysis
- Test generation
- Documentation
- Complex refactoring

## Monitoring & Observability

### View Agent Logs

```bash
scriptpay-agent logs
scriptpay-agent logs --agent security
scriptpay-agent logs --since 24h
```

### View Agent Metrics

```bash
scriptpay-agent metrics
```

Output:

```
Security Agent
  Last run: 2024-01-15 02:00 UTC
  Duration: 8m 32s
  Files analyzed: 127
  Issues found: 3
  PRs created: 1
  Status: ✓ Success

Quality Agent
  Last run: 2024-01-15 02:30 UTC
  Duration: 12m 15s
  Files analyzed: 342
  Improvements: 18
  PRs created: 1
  Status: ✓ Success
```

### View Pending Changes

```bash
scriptpay-agent status
```

## Configuration Options

### Per-Agent Config

```json
{
  "agents": {
    "security": {
      "enabled": true,
      "schedule": "0 0 * * 0",
      "onPullRequest": true,
      "autoPush": false,
      "autoMerge": false,
      "reviewers": ["@security-team"],
      "labels": ["security"],
      "blockers": ["failing-tests", "low-coverage"]
    },
    "quality": {
      "enabled": true,
      "schedule": "0 2 * * *",
      "autoMerge": true,
      "autoMergeConditions": {
        "passTests": true,
        "maintainCoverage": true,
        "noPolicyViolations": true
      }
    }
  },
  "global": {
    "branchPrefix": "agent/",
    "commitPrefix": "[agent]",
    "slackWebhook": "https://hooks.slack.com/...",
    "githubToken": "${GITHUB_TOKEN}",
    "gitUser": "scriptpay-bot"
  }
}
```

## Example: Running Security Agent

```bash
$ scriptpay-agent run security

┌─────────────────────────────────────────┐
│  Security Agent Starting                │
│  Scanning 127 files...                  │
└─────────────────────────────────────────┘

✓ JWT validation: 3 files checked
⚠ Found: Missing CSRF token validation in POST /invoices
⚠ Found: console.log with sensitive data in auth.service.ts
⚠ Found: Dependency outdated: lodash@4.17.19 (CVE-2021-23337)

Creating branch: agent/security-2024-01-15
Committing fixes...
Pushing to remote...

✓ PR created: security-fixes-2024-01-15
  - 3 vulnerabilities fixed
  - All tests passing
  - Ready for review

Report saved: .claude/agent-logs/security-2024-01-15.md
```

## Next Steps

1. **Set up agent CLI** (see CLI documentation below)
2. **Configure agents** (`.claude/agents.json`)
3. **Test locally** (`scriptpay-agent run audit`)
4. **Schedule agents** (cron or GitHub Actions)
5. **Monitor & iterate** (adjust based on results)

## Related Documentation

- **Agent Implementation**: See specific agent guides
- **Prompts**: `.claude/prompts/agents/`
- **Configuration**: `.claude/agents.json`
- **Logs**: `.claude/agent-logs/`

---

## FAQ

**Q: Can agents deploy to production?**  
A: No. Agents create PRs for review. Production deployment requires manual approval.

**Q: What if an agent breaks something?**  
A: PRs are reviewable before merge. Rollback via Git. Logs track all changes.

**Q: How much does running agents cost?**  
A: Depends on frequency and code size. Budget ~$10-50/month for 4 daily agents.

**Q: Can I customize agent behavior?**  
A: Yes. Modify prompts in `.claude/prompts/agents/` and config in `.claude/agents.json`.

**Q: How do I disable an agent?**  
A: Set `"enabled": false` in `.claude/agents.json`.
