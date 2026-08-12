# Agent System Integration Guide

Complete walkthrough for integrating the agent system with your existing ScriptPay project.

## Overview

This guide will help you:

1. Set up the agent CLI tool
2. Configure agents for your project
3. Integrate with GitHub/CI-CD
4. Monitor agent runs
5. Handle agent output

Estimated setup time: 30-45 minutes

## Step 1: Install Agent CLI

### 1.1 Install Globally (Recommended)

```bash
npm install -g scriptpay-agent

# Verify installation
scriptpay-agent --version
```

### 1.2 Or Install Locally

```bash
cd /path/to/scriptpay
npm install --save-dev scriptpay-agent

# Verify
npx scriptpay-agent --version
```

### 1.3 Verify Installation

```bash
scriptpay-agent config
# Should output: Configuration loaded successfully
```

## Step 2: Set Up Environment

### 2.1 Create `.env` File

```bash
cd /path/to/scriptpay

cat > .env.local << 'EOF'
# GitHub Configuration
GITHUB_TOKEN=ghp_xxxxxxxxxxxxx
GITHUB_OWNER=your-username-or-org
GITHUB_REPO=scriptpay

# Notifications (Optional)
SLACK_WEBHOOK=https://hooks.slack.com/services/YOUR/WEBHOOK/URL

# Agent Configuration
LOG_LEVEL=info
DRY_RUN=false
VERBOSE=false

# Claude Integration (Optional)
OPENAI_API_KEY=sk_xxxxxxxxxxxxx
EOF

# Don't commit .env.local!
echo ".env.local" >> .gitignore
```

### 2.2 Get GitHub Token

```bash
# 1. Go to https://github.com/settings/tokens
# 2. Click "Generate new token"
# 3. Select scopes:
#    - repo (full control of private repositories)
#    - workflow (update GitHub Action workflows)
#    - read:org (read organization)
# 4. Generate token
# 5. Copy to .env.local as GITHUB_TOKEN
```

## Step 3: Configure Agents

### 3.1 Create Agent Configuration

```bash
mkdir -p .claude

cat > .claude/agents.json << 'EOF'
{
  "agents": {
    "security": {
      "enabled": true,
      "schedule": "0 0 * * 0",
      "onPullRequest": true,
      "autoPush": true,
      "autoMerge": false,
      "labels": ["security", "agent"],
      "reviewers": []
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
      },
      "labels": ["quality", "agent"]
    },
    "audit": {
      "enabled": true,
      "schedule": "0 3 * * *",
      "createIssues": true,
      "issueLabels": ["audit", "agent"],
      "labels": ["audit", "agent"]
    },
    "feature": {
      "enabled": true,
      "manual": true,
      "autoPush": false,
      "requiresReview": true,
      "labels": ["feature", "agent"]
    }
  },
  "global": {
    "branchPrefix": "agent/",
    "commitPrefix": "[agent]",
    "dryRun": false,
    "verbose": false,
    "gitUser": "scriptpay-agent",
    "gitEmail": "agent@scriptpay.io"
  }
}
EOF
```

### 3.2 Test Configuration

```bash
# Validate configuration
scriptpay-agent config --validate

# View loaded configuration
scriptpay-agent config

# Test GitHub connection
scriptpay-agent status --check-connection
```

## Step 4: Test Agents Locally

### 4.1 Dry Run Test

```bash
# Run audit agent in dry-run mode (won't make changes)
scriptpay-agent run audit --dry-run

# Run quality agent in dry-run mode
scriptpay-agent run quality --dry-run

# View what would happen
scriptpay-agent logs --agent quality
```

### 4.2 First Real Run

```bash
# Start with audit (read-only)
scriptpay-agent run audit

# View results
scriptpay-agent logs --agent audit
scriptpay-agent metrics --agent audit

# Check for any issues
scriptpay-agent status
```

## Step 5: Set Up GitHub Actions

### 5.1 Create Workflows Directory

```bash
mkdir -p .github/workflows
```

### 5.2 Create Scheduled Agent Workflow

```bash
cat > .github/workflows/agents.yml << 'EOF'
name: Agent System

on:
  # Scheduled runs
  schedule:
    # Security audit: Sundays at 2 AM UTC
    - cron: '0 2 * * 0'
    # Quality check: Daily at 2 AM UTC
    - cron: '0 2 * * *'
    # System audit: Daily at 3 AM UTC
    - cron: '0 3 * * *'

  # Manual trigger
  workflow_dispatch:
    inputs:
      agent:
        description: 'Agent to run'
        required: true
        default: 'all'
        type: choice
        options:
          - security
          - quality
          - audit
          - all

jobs:
  agents:
    runs-on: ubuntu-latest

    permissions:
      contents: write
      pull-requests: write
      issues: write

    steps:
      - name: Checkout code
        uses: actions/checkout@v3
        with:
          fetch-depth: 0

      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '18'
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Install agent CLI
        run: npm install -g scriptpay-agent

      - name: Configure Git
        run: |
          git config --global user.name "scriptpay-agent"
          git config --global user.email "agent@scriptpay.io"

      - name: Run agents
        run: |
          if [ "${{ github.event_name }}" == "workflow_dispatch" ]; then
            scriptpay-agent run ${{ github.event.inputs.agent }}
          else
            # Determine which agent based on schedule
            HOUR=$(date -u +%H)
            if [ "$HOUR" == "02" ] && [ "$(date -u +%w)" == "0" ]; then
              scriptpay-agent run security
            elif [ "$HOUR" == "02" ]; then
              scriptpay-agent run quality
            elif [ "$HOUR" == "03" ]; then
              scriptpay-agent run audit
            fi
          fi
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}

      - name: Upload logs
        if: always()
        uses: actions/upload-artifact@v3
        with:
          name: agent-logs
          path: .claude/agent-logs/
          retention-days: 30

      - name: Notify Slack
        if: failure()
        uses: slackapi/slack-github-action@v1
        with:
          webhook-url: ${{ secrets.SLACK_WEBHOOK }}
          payload: |
            {
              "text": "⚠️ Agent failed: ${{ job.status }}",
              "blocks": [
                {
                  "type": "section",
                  "text": {
                    "type": "mrkdwn",
                    "text": "Agent workflow failed\n*Repo:* ${{ github.repository }}\n*Run:* ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}"
                  }
                }
              ]
            }
EOF
```

### 5.3 Push Workflow

```bash
git add .github/workflows/agents.yml
git commit -m "chore: add agent workflows"
git push origin main
```

## Step 6: Create PR Labels

```bash
# Create GitHub labels for agent PRs
gh label create security --color=d73a49 --description "Security fixes"
gh label create quality --color=0075ca --description "Code quality improvements"
gh label create audit --color=fbca04 --description "System audit findings"
gh label create agent --color=cccccc --description "Automated agent changes"
```

## Step 7: Manual Agent Testing

### 7.1 Run Audit Agent

```bash
scriptpay-agent run audit

# View results
scriptpay-agent logs --agent audit
scriptpay-agent metrics --agent audit
```

### 7.2 Review Issues

```bash
# Check GitHub issues created
gh issue list --label audit

# Review findings
scriptpay-agent status
```

### 7.3 Run Quality Agent

```bash
scriptpay-agent run quality --verbose

# View generated PR
scriptpay-agent prs --agent quality

# Check what changed
git diff agent/quality-*
```

## Step 8: Monitor Agent Runs

### 8.1 Check Agent Status

```bash
# View overall status
scriptpay-agent status

# View metrics
scriptpay-agent metrics

# View recent runs
scriptpay-agent history --days 7
```

### 8.2 View Pending PRs

```bash
# List all agent PRs
scriptpay-agent prs

# Filter by agent
scriptpay-agent prs --agent security
scriptpay-agent prs --agent quality

# View specific PR
scriptpay-agent prs --agent security --status pending
```

### 8.3 Check Logs

```bash
# View latest logs
scriptpay-agent logs

# View specific agent logs
scriptpay-agent logs --agent audit

# View logs from last 24 hours
scriptpay-agent logs --since 24h

# View detailed logs
scriptpay-agent logs --agent security --tail 100 --verbose
```

## Step 9: Configure Slack Notifications (Optional)

### 9.1 Create Slack Webhook

```bash
# 1. Go to https://api.slack.com/apps
# 2. Create New App > From scratch
# 3. Name: ScriptPay Agents
# 4. Select workspace
# 5. Activate Incoming Webhooks
# 6. Add New Webhook to Workspace
# 7. Select channel #engineering
# 8. Copy webhook URL
```

### 9.2 Add Webhook to Configuration

```bash
# Update .env.local
echo "SLACK_WEBHOOK=https://hooks.slack.com/services/YOUR/WEBHOOK" >> .env.local

# Verify
scriptpay-agent config | grep slack
```

## Step 10: First Production Run

### 10.1 Enable Agents (One at a Time)

```bash
# 1. Start with audit (read-only)
scriptpay-agent config set agents.audit.enabled true
scriptpay-agent run audit

# Review findings
scriptpay-agent logs --agent audit

# 2. Then quality (safer)
scriptpay-agent config set agents.quality.enabled true
scriptpay-agent run quality --verbose

# Review generated PR
scriptpay-agent prs --agent quality

# 3. Finally security
scriptpay-agent config set agents.security.enabled true
scriptpay-agent run security --verbose

# Review findings
scriptpay-agent prs --agent security
```

### 10.2 Adjust Schedule (Optional)

```bash
# Change security check to run Friday at 2 AM instead of Sunday
scriptpay-agent config set agents.security.schedule "0 2 * * 5"

# Verify
scriptpay-agent config | grep schedule
```

## Step 11: Handle Agent Output

### 11.1 Review PRs

When agents create PRs:

```bash
# 1. List agent PRs
gh pr list --label agent

# 2. Review specific PR
gh pr view agent/security-2024-01-15

# 3. Check CI status
gh pr checks agent/security-2024-01-15

# 4. Merge when ready
gh pr merge agent/security-2024-01-15 --auto
```

### 11.2 Review Issues

When audit agent finds issues:

```bash
# 1. List all audit issues
gh issue list --label audit

# 2. View issue details
gh issue view <number>

# 3. Close when resolved
gh issue close <number> --comment "Fixed in PR #xyz"
```

## Step 12: Customize Agent Behavior

### 12.1 Disable Specific Agent

```bash
# Temporarily disable quality agent
scriptpay-agent config set agents.quality.enabled false

# Re-enable
scriptpay-agent config set agents.quality.enabled true
```

### 12.2 Change Agent Schedule

```bash
# Run quality agent twice daily
scriptpay-agent config set agents.quality.schedule "0 2,14 * * *"

# Run security agent every Friday
scriptpay-agent config set agents.security.schedule "0 2 * * 5"

# Verify changes
scriptpay-agent config
```

### 12.3 Add Code Reviewers

```bash
# Add security team as reviewers for security PRs
scriptpay-agent config set agents.security.reviewers '["@security-team","@lead-dev"]'
```

## Troubleshooting

### Issue: "GitHub token invalid"

```bash
# 1. Verify token is set
echo $GITHUB_TOKEN

# 2. Check token has correct scopes
# Go to https://github.com/settings/tokens
# Should have: repo, workflow, read:org

# 3. If needed, create new token and update .env
```

### Issue: "Agent won't create PR"

```bash
# 1. Check Git configuration
git config --global user.name
git config --global user.email

# 2. Verify branch exists
git branch --list | grep agent/

# 3. Check Git permissions
scriptpay-agent status --check-permissions

# 4. Debug with verbose
scriptpay-agent run quality --verbose --debug
```

### Issue: "Tests failing in agent PR"

```bash
# 1. Run tests locally first
npm test

# 2. Check if test suite is broken
npm test -- --bail

# 3. Disable auto-merge temporarily
scriptpay-agent config set agents.quality.autoMerge false

# 4. Fix tests, then re-enable
npm test
scriptpay-agent config set agents.quality.autoMerge true
```

## Complete Checklist

Before going to production:

- [ ] GitHub token created and configured
- [ ] Agent CLI installed and verified
- [ ] `.claude/agents.json` created and validated
- [ ] GitHub Actions workflows created
- [ ] Labels created on GitHub
- [ ] Slack webhook configured (optional)
- [ ] Audit agent tested (read-only)
- [ ] Quality agent tested (creates PRs)
- [ ] Security agent tested
- [ ] Logs reviewed and understood
- [ ] Team notified of agent system
- [ ] Documentation updated with agent info
- [ ] Monitoring dashboard opened
- [ ] PR merge strategy decided (auto vs manual)

## Post-Setup Monitoring

### Weekly Tasks

```bash
# Monday morning
scriptpay-agent status
scriptpay-agent prs

# Review open agent PRs
# Merge successful ones

# Friday
scriptpay-agent metrics --period week
# Review weekly metrics
# Adjust if needed
```

### Monthly Tasks

```bash
# Beginning of month
scriptpay-agent report --format html > agent-report-jan.html
# Review report
# Adjust schedules if needed

# Share metrics with team
# Discuss improvements
```

## Best Practices

1. **Start Cautiously**: Test each agent before enabling
2. **Monitor Closely**: Check logs regularly in first weeks
3. **Adjust Schedules**: Don't run all agents at same time
4. **Review PRs**: Always review agent changes before merge
5. **Keep Docs Updated**: Update docs as you customize agents
6. **Set Expectations**: Tell team agents will create PRs

## Next Steps

1. ✅ Complete this setup guide
2. 📖 Read individual agent guides:
   - `.claude/security-agent-prompt.md`
   - `.claude/quality-agent-prompt.md`
   - `.claude/audit-agent-prompt.md`
   - `.claude/feature-agent-prompt.md`
3. 🚀 Start running agents daily
4. 📊 Monitor metrics weekly
5. 🎯 Fine-tune based on results

## Support

If issues arise:

1. Check logs: `scriptpay-agent logs --verbose`
2. Review configuration: `scriptpay-agent config --validate`
3. Test connection: `scriptpay-agent status --check-connection`
4. Debug: `scriptpay-agent run --debug`
5. Check GitHub Actions: `.github/workflows/agents.yml`

---

**Last Updated**: 2024-01-15  
**Setup Time**: ~45 minutes  
**Maintenance**: ~5 minutes/day
