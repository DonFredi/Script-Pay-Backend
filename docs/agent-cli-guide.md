# Agent CLI Tool Guide

The `scriptpay-agent` CLI tool manages agent execution, scheduling, and monitoring.

## Installation

### Option 1: Global Install (Recommended for Development)

```bash
npm install -g scriptpay-agent
```

### Option 2: Local Install

```bash
npm install --save-dev scriptpay-agent
npx scriptpay-agent --help
```

### Option 3: Docker

```bash
docker run -v $(pwd):/app scriptpay-agent run security
```

## Configuration

### `.claude/agents.json`

Main configuration file for all agents:

```json
{
  "agents": {
    "security": {
      "enabled": true,
      "schedule": "0 0 * * 0",
      "onPullRequest": true,
      "autoPush": true,
      "autoMerge": false,
      "labels": ["security"],
      "reviewers": ["@security-team"]
    },
    "quality": {
      "enabled": true,
      "schedule": "0 2 * * *",
      "autoPush": true,
      "autoMerge": true,
      "autoMergeConditions": {
        "passTests": true,
        "maintainCoverage": true,
        "noPolicyViolations": true
      }
    },
    "audit": {
      "enabled": true,
      "schedule": "0 3 * * *",
      "createIssues": true,
      "issueLabels": ["audit"]
    },
    "feature": {
      "enabled": true,
      "manual": true,
      "autoPush": false,
      "requiresReview": true
    }
  },
  "global": {
    "branchPrefix": "agent/",
    "commitPrefix": "[agent]",
    "dryRun": false,
    "verbose": false,
    "slackWebhook": "${SLACK_WEBHOOK}",
    "githubToken": "${GITHUB_TOKEN}",
    "gitUser": "scriptpay-agent",
    "gitEmail": "agent@scriptpay.io"
  }
}
```

### Environment Variables

```bash
# Required
export GITHUB_TOKEN=ghp_xxxx    # GitHub personal access token
export GITHUB_OWNER=scriptpay   # Repository owner
export GITHUB_REPO=scriptpay    # Repository name

# Optional
export SLACK_WEBHOOK=https://hooks.slack.com/...
export OPENAI_API_KEY=sk_xxx    # For Claude Code integration
export LOG_LEVEL=info            # debug, info, warn, error
```

### `.env` File

```bash
# .env (not committed to git)
GITHUB_TOKEN=ghp_xxx
GITHUB_OWNER=scriptpay
GITHUB_REPO=scriptpay
SLACK_WEBHOOK=https://hooks.slack.com/...
```

## Commands

### Run Agents

```bash
# Run specific agent
scriptpay-agent run security
scriptpay-agent run quality
scriptpay-agent run audit
scriptpay-agent run feature

# Run all agents
scriptpay-agent run all

# Run with options
scriptpay-agent run security --dry-run    # Preview changes
scriptpay-agent run quality --verbose     # Detailed output
scriptpay-agent run audit --force         # Skip cache

# Run with custom config
scriptpay-agent run --config ./custom-config.json
```

### Generate Features

```bash
# Generate feature from roadmap
scriptpay-agent feature --feature "subscription-support"
scriptpay-agent feature --from-roadmap

# Interactive feature selection
scriptpay-agent feature --interactive

# Generate multiple features
scriptpay-agent feature --features "feature1,feature2"
```

### Status & Monitoring

```bash
# View current status
scriptpay-agent status

# View agent logs
scriptpay-agent logs
scriptpay-agent logs --agent security
scriptpay-agent logs --since 24h
scriptpay-agent logs --tail 50

# View agent metrics
scriptpay-agent metrics
scriptpay-agent metrics --agent quality
scriptpay-agent metrics --period week

# View pending PRs
scriptpay-agent prs
scriptpay-agent prs --agent security
scriptpay-agent prs --status pending
```

### History & Reports

```bash
# View run history
scriptpay-agent history
scriptpay-agent history --agent audit
scriptpay-agent history --days 7

# Export reports
scriptpay-agent report --format json > report.json
scriptpay-agent report --format csv > report.csv
scriptpay-agent report --format html > report.html

# View specific run
scriptpay-agent history 2024-01-15
scriptpay-agent history --id run_abc123
```

### Configuration

```bash
# Show current configuration
scriptpay-agent config

# Validate configuration
scriptpay-agent config --validate

# Update configuration
scriptpay-agent config set agents.security.enabled false
scriptpay-agent config set global.dryRun true

# Reset configuration
scriptpay-agent config reset
```

### Scheduling

```bash
# Start daemon (background scheduler)
scriptpay-agent daemon start

# Stop daemon
scriptpay-agent daemon stop

# View daemon status
scriptpay-agent daemon status

# View daemon logs
scriptpay-agent daemon logs

# Schedule manual run
scriptpay-agent schedule security --at "2024-01-20 14:00"
```

### Advanced

```bash
# Dry run (preview changes without committing)
scriptpay-agent run security --dry-run

# Skip tests (faster, use with caution)
scriptpay-agent run quality --skip-tests

# Force push (override rate limiting)
scriptpay-agent run security --force-push

# Custom branch
scriptpay-agent run feature --branch "feature/custom-branch"

# Debug mode
scriptpay-agent run --debug

# Verbose output
scriptpay-agent run --verbose --debug
```

## Usage Examples

### Daily Maintenance

```bash
# 1. Run audit to check system health
scriptpay-agent run audit

# 2. View any critical issues
scriptpay-agent logs --since 1h

# 3. Review pending PRs
scriptpay-agent prs

# 4. Check metrics
scriptpay-agent metrics --period day
```

### Weekly Workflow

```bash
# Monday morning
scriptpay-agent status

# Wednesday (quality cleanup)
scriptpay-agent run quality --verbose

# Friday (security check)
scriptpay-agent run security

# Review all PRs before weekend
scriptpay-agent prs --status pending
```

### Generate New Feature

```bash
# 1. Check roadmap
cat docs/roadmap.md

# 2. Generate feature
scriptpay-agent feature --feature "subscription-support"

# 3. Review generated PR
scriptpay-agent prs --agent feature

# 4. Monitor generation logs
scriptpay-agent logs --agent feature --tail 100
```

### Troubleshooting

```bash
# Enable debug output
scriptpay-agent run security --debug

# Dry run to preview changes
scriptpay-agent run quality --dry-run

# View detailed logs
scriptpay-agent logs --agent security --verbose --tail 200

# Check configuration
scriptpay-agent config --validate

# Test GitHub connection
scriptpay-agent status --check-connection
```

## Scheduled Runs

### GitHub Actions Setup

Create `.github/workflows/agents.yml`:

```yaml
name: Automated Agents

on:
  schedule:
    # Security audit every Sunday at 2 AM
    - cron: "0 2 * * 0"
    # Quality check daily at 2 AM
    - cron: "0 2 * * *"
    # Audit daily at 3 AM
    - cron: "0 3 * * *"

jobs:
  agents:
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v3

      - name: Setup Node
        uses: actions/setup-node@v3
        with:
          node-version: "18"

      - name: Install agent
        run: npm install -g scriptpay-agent

      - name: Run security agent
        if: github.event.schedule == '0 2 * * 0'
        run: scriptpay-agent run security
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}

      - name: Run quality agent
        if: github.event.schedule == '0 2 * * *'
        run: scriptpay-agent run quality
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}

      - name: Run audit agent
        if: github.event.schedule == '0 3 * * *'
        run: scriptpay-agent run audit
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

### Cron Schedule Format

```
*    *    *    *    *
|    |    |    |    |
|    |    |    |    +-- Day of Week (0-6)
|    |    |    +------ Month (1-12)
|    |    +---------- Day of Month (1-31)
|    +-------------- Hour (0-23)
+------------------ Minute (0-59)

Examples:
0 2 * * *       Every day at 2 AM
0 2 * * 0       Every Sunday at 2 AM
0 2 * * 1-5     Weekdays at 2 AM
0 2,14 * * *    Every day at 2 AM and 2 PM
*/30 * * * *    Every 30 minutes
```

## Dashboard

View agent activities in web dashboard:

```bash
# Start dashboard server
scriptpay-agent dashboard

# Dashboard available at http://localhost:3999
# Shows:
# - Agent status and last run times
# - Pending PRs and issues
# - System health metrics
# - Run history charts
# - Configuration overview
```

## Integration with Claude Code

### Using Agent Prompts in Claude Code

```bash
# 1. Open Claude Code
claude-code

# 2. Load agent prompt
claude-code > load-prompt security

# 3. Run agent workflow
claude-code > run-security-audit

# 4. Review changes
claude-code > git diff

# 5. Commit and push
claude-code > commit-and-push
```

### Claude Code Integration Config

```json
{
  "agents": {
    "integration": {
      "claudeCodePath": "/path/to/claude-code",
      "useClaudeAPI": true,
      "claudeModel": "claude-sonnet-4-6",
      "maxTokens": 200000
    }
  }
}
```

## Monitoring & Alerts

### Slack Notifications

```bash
# Configure in .claude/agents.json
"global": {
  "slackWebhook": "https://hooks.slack.com/services/..."
}
```

Notifications sent for:

- Agent run started
- Agent run completed
- Critical issues found
- PR created
- PR merged
- Agent failure

### Email Alerts

```bash
# Configure
scriptpay-agent config set notifications.email admin@example.com
scriptpay-agent config set notifications.alertConditions "critical,highPriority"
```

## Troubleshooting

### Agent Won't Start

```bash
# Check configuration
scriptpay-agent config --validate

# Check GitHub connection
scriptpay-agent status --check-connection

# View detailed logs
scriptpay-agent logs --agent security --verbose
```

### PRs Not Creating

```bash
# Check Git configuration
git config --global user.name
git config --global user.email

# Verify GitHub token
echo $GITHUB_TOKEN

# Check branch permissions
scriptpay-agent status --check-permissions
```

### Out of Memory

```bash
# Run with memory limit
NODE_OPTIONS=--max-old-space-size=2048 scriptpay-agent run audit

# Or split across smaller scans
scriptpay-agent run quality --files "src/auth/**"
```

## Performance Tuning

### Run Faster

```bash
# Skip tests
scriptpay-agent run quality --skip-tests

# Skip linting
scriptpay-agent run quality --skip-lint

# Smaller scope
scriptpay-agent run security --files "src/payments/**"

# Parallel execution
scriptpay-agent run all --parallel
```

### Reduce Costs

```bash
# Run less frequently
scriptpay-agent config set agents.quality.schedule "0 3 * * 1,3,5"

# Smaller code scope
scriptpay-agent config set "global.maxFilesPerRun: 50"

# Cache results
scriptpay-agent config set "global.cacheResults: true"
```

## API Reference

The agent system exposes a REST API:

```bash
# Get agent status
curl http://localhost:3999/api/agents

# Get specific agent
curl http://localhost:3999/api/agents/security

# Get recent runs
curl http://localhost:3999/api/runs?limit=10

# Trigger agent
curl -X POST http://localhost:3999/api/agents/quality/run

# Get metrics
curl http://localhost:3999/api/metrics

# Get PRs
curl http://localhost:3999/api/prs
```

## Complete Example Setup

```bash
# 1. Install
npm install -g scriptpay-agent

# 2. Configure
cat > .claude/agents.json << 'EOF'
{
  "agents": {
    "security": { "enabled": true, "schedule": "0 0 * * 0" },
    "quality": { "enabled": true, "schedule": "0 2 * * *" },
    "audit": { "enabled": true, "schedule": "0 3 * * *" }
  },
  "global": {
    "githubToken": "${GITHUB_TOKEN}",
    "slackWebhook": "${SLACK_WEBHOOK}"
  }
}
EOF

# 3. Set environment
export GITHUB_TOKEN=ghp_xxx
export GITHUB_OWNER=yourorg
export GITHUB_REPO=scriptpay
export SLACK_WEBHOOK=https://hooks.slack.com/...

# 4. Start daemon
scriptpay-agent daemon start

# 5. Monitor
scriptpay-agent dashboard

# 6. View status
scriptpay-agent status
scriptpay-agent metrics
```

---

**Last Updated**: 2024-01-15 **Version**: 1.0
