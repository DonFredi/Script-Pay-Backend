# ScriptPay Agent System - Quick Start

You now have a **complete autonomous agent system** for maintaining and upgrading your payment platform.

## What You Have

### 📚 Documentation (17 files)

**Agent System Files** (New):

- `agent-system-overview.md` - Architecture & how agents work
- `security-agent-prompt.md` - Vulnerability detection & fixes
- `quality-agent-prompt.md` - Code quality improvements
- `audit-agent-prompt.md` - System health monitoring
- `feature-agent-prompt.md` - Feature generation from roadmap
- `agent-cli-guide.md` - How to use the CLI tool
- `agent-integration-guide.md` - Setup with your project (⭐ START HERE)

**Project Documentation** (Existing):

- `README.md` - Navigation hub
- `architecture.md` - System design
- `database.md` - Schema & queries
- `api.md` - API reference
- `security.md` - Security requirements
- `coding-standards.md` - Code conventions
- `deployment.md` - Deployment procedures
- `CLAUDE.md` - How Claude fits in
- `nestjs-skill.md` - NestJS patterns
- `security-audit-skill.md` - Security checklist

## 5-Minute Setup

### Step 1: Install Agent CLI

```bash
npm install -g scriptpay-agent
scriptpay-agent --version
```

### Step 2: Configure Agents

```bash
# Create .claude/agents.json (see agent-integration-guide.md)
cat > .claude/agents.json << 'EOF'
{
  "agents": {
    "security": { "enabled": true, "schedule": "0 0 * * 0" },
    "quality": { "enabled": true, "schedule": "0 2 * * *" },
    "audit": { "enabled": true, "schedule": "0 3 * * *" }
  },
  "global": {
    "githubToken": "${GITHUB_TOKEN}",
    "gitUser": "scriptpay-agent"
  }
}
EOF
```

### Step 3: Set Environment

```bash
export GITHUB_TOKEN=ghp_xxx  # Your GitHub token
export GITHUB_OWNER=your-org
export GITHUB_REPO=scriptpay
```

### Step 4: Test

```bash
# Dry run (no changes)
scriptpay-agent run audit --dry-run

# View results
scriptpay-agent logs --agent audit
```

### Step 5: Deploy Workflows

```bash
# Copy .github/workflows/agents.yml (see agent-integration-guide.md)
# Push to GitHub
git add .github/workflows/agents.yml
git push origin main
```

**Done!** ✅ Your agents are now running autonomously.

## How It Works

### The Four Agents

```
┌─────────────────────────────────────────────────────┐
│         4 Autonomous Agents Working Together        │
├──────────┬──────────┬──────────┬──────────────────┤
│ Security │ Quality  │  Audit   │ Feature Generator│
│ (Weekly) │ (Daily)  │ (Daily)  │ (On-Demand)      │
└──────────┴──────────┴──────────┴──────────────────┘
     │          │          │           │
     └──────────┴──────────┴───────────┘
            ↓
      Analyze Code
      Find Issues
      Generate Fixes
      Create PRs
```

### 1. Security Agent

Runs every **Sunday 2 AM**

✓ Finds vulnerabilities (OWASP Top 10)  
✓ Scans dependencies for CVEs  
✓ Verifies payment security  
✓ Creates PR with fixes

**Example finding**: Hardcoded API key → Auto-fixes to use env var

### 2. Quality Agent

Runs **every day 2 AM**

✓ Reduces code complexity  
✓ Improves test coverage  
✓ Fixes code style  
✓ Removes dead code  
✓ Auto-merges if tests pass

**Example finding**: Function with complexity 8 → Refactored to 4

### 3. Audit Agent

Runs **every day 3 AM**

✓ Checks for secrets in code  
✓ Validates database queries  
✓ Reviews error handling  
✓ Tracks technical debt  
✓ Creates GitHub issues

**Example finding**: Missing database index → Creates issue with fix

### 4. Feature Agent

Runs **on-demand**

✓ Reads roadmap  
✓ Generates complete features  
✓ Creates API + frontend  
✓ Writes tests & docs  
✓ Creates PR for review

**Example**: `scriptpay-agent feature --feature "subscription-support"`

## Running Agents with Claude Code

### Option 1: Local Testing (Before Deployment)

```bash
# 1. Open Claude Code
claude-code

# 2. Run audit agent
claude-code > scriptpay-agent run audit --dry-run

# 3. Review findings
claude-code > cat .claude/agent-logs/audit-*.md

# 4. If good, run for real
claude-code > scriptpay-agent run audit
```

### Option 2: Interactive Feature Generation

```bash
# 1. Open Claude Code
claude-code

# 2. Generate feature
claude-code > scriptpay-agent feature --feature "subscription-support"

# 3. Review generated code
claude-code > git diff agent/feature-*

# 4. Test
claude-code > npm test

# 5. Push
claude-code > git push origin agent/feature-*
```

### Option 3: Automated Security Fix

```bash
# 1. Open Claude Code
claude-code

# 2. Run security scan
claude-code > scriptpay-agent run security

# 3. View PR created
claude-code > gh pr list --label security

# 4. Review & merge when ready
claude-code > gh pr merge agent/security-* --auto
```

## Agent Output

### What Agents Create

**1. GitHub Pull Requests**

- Titled: `[agent] security: fix CVE-2024-xxx`
- With fixes and tests
- Labeled: `security`, `agent`, etc.
- Ready for review

**2. GitHub Issues**

- From audit findings
- Labeled: `audit`, `high-priority`
- With detailed descriptions
- Link to fixing PRs

**3. Audit Reports**

- Location: `.claude/agent-logs/`
- Format: Markdown
- Metrics & findings
- Actionable recommendations

**4. Generated Features**

- Complete PR with:
  - Backend (NestJS)
  - Frontend (Next.js)
  - Database migrations
  - Tests
  - Documentation

## Daily Workflow

### Morning (5 minutes)

```bash
# Check what agents found
scriptpay-agent status
scriptpay-agent prs

# Review pending PRs
gh pr list --label agent
```

### Review & Merge (As needed)

```bash
# Review PR
gh pr view agent/quality-*

# Check CI status
gh pr checks agent/quality-*

# Merge when ready
gh pr merge agent/quality-* --auto
```

### Weekly (10 minutes)

```bash
# View metrics
scriptpay-agent metrics --period week

# Generate report
scriptpay-agent report --format html > report.html

# Share with team
# Discuss improvements
```

## Key Files to Know

```
Your Project
├── .claude/
│   ├── agents.json                    ← Agent configuration
│   ├── agent-logs/                    ← Agent run logs
│   ├── CLAUDE.md                      ← Claude integration guide
│   ├── security-agent-prompt.md       ← Security agent spec
│   ├── quality-agent-prompt.md        ← Quality agent spec
│   ├── audit-agent-prompt.md          ← Audit agent spec
│   └── feature-agent-prompt.md        ← Feature agent spec
│
├── .github/workflows/
│   └── agents.yml                     ← Scheduled agent runs
│
├── docs/
│   ├── architecture.md                ← System design
│   ├── security.md                    ← Security requirements
│   ├── coding-standards.md            ← Code conventions
│   ├── roadmap.md                     ← Feature roadmap
│   └── ...other docs...
│
└── src/
    ├── ...your code...
    └── (agents improve this)
```

## Common Commands

```bash
# Run specific agent
scriptpay-agent run security
scriptpay-agent run quality
scriptpay-agent run audit
scriptpay-agent run all

# Generate feature
scriptpay-agent feature --feature "name"

# View status
scriptpay-agent status
scriptpay-agent metrics
scriptpay-agent prs
scriptpay-agent logs

# Manage configuration
scriptpay-agent config
scriptpay-agent config set agents.security.enabled false
scriptpay-agent config --validate

# Daemon (background)
scriptpay-agent daemon start
scriptpay-agent daemon stop
scriptpay-agent daemon status
```

## Example Day in the Life

### Monday 2 AM

Security agent runs → Finds hardcoded Stripe key → Creates PR → Tests pass → Merged ✅

### Tuesday 2 AM

Quality agent runs → Refactors complex auth service → Creates PR → Auto-merges ✅

### Wednesday (2 PM)

Developer: `scriptpay-agent feature --feature "subscriptions"`  
→ Agent generates complete feature  
→ Creates PR  
→ Developer reviews & merges ✅

### Thursday 3 AM

Audit agent runs → Finds test coverage gap → Creates issue → Added to backlog 📝

### Friday 2 AM

Quality agent → Better code pushed  
Audit agent → System health report  
Team: Review metrics, plan improvements 📊

## Costs & Performance

### Monthly Cost

- **Free tier**: 0-5 agent runs/day = ~$0-5/month
- **Standard**: 10 agents/day = ~$15-30/month
- **Heavy use**: 20+ agents/day = ~$50-100/month

### Performance Impact

- Agent runs don't block your work
- PRs created on separate branches
- No impact on production
- Tests run in parallel with agents

## Best Practices

1. **Start Small** - Enable audit first (read-only)
2. **Review PRs** - Always review before auto-merge
3. **Monitor Logs** - Check `.claude/agent-logs/` regularly
4. **Adjust Schedules** - Don't run all agents at once
5. **Keep Docs Updated** - Update when you customize
6. **Set Expectations** - Tell team about agents
7. **Use Slack Alerts** - Get notified of issues
8. **Review Metrics** - Track improvements over time

## Next Steps

### ✅ For Setup

1. Read: `agent-integration-guide.md` (detailed setup)
2. Follow: Step-by-step instructions
3. Test: `scriptpay-agent run audit --dry-run`
4. Deploy: GitHub Actions workflow
5. Monitor: `scriptpay-agent status`

### 📚 For Deep Dives

- Agent behavior: Read individual `*-agent-prompt.md` files
- CLI commands: Read `agent-cli-guide.md`
- Architecture: Read `agent-system-overview.md`
- Security: Read `security-agent-prompt.md`

### 🚀 For Using with Claude Code

1. Open Claude Code
2. `scriptpay-agent run audit` (test an agent)
3. Review output
4. `scriptpay-agent feature --feature "name"` (generate feature)
5. Use Claude Code to refine generated code
6. Push and deploy

## Troubleshooting Quick Links

| Issue                 | Solution                                                   |
| --------------------- | ---------------------------------------------------------- |
| GitHub token invalid  | Check `agent-integration-guide.md` Step 2                  |
| Agent won't create PR | See troubleshooting in `agent-integration-guide.md` Step 9 |
| Tests failing         | `npm test` locally, then fix before agents run             |
| Too many PRs          | Adjust schedule in `.claude/agents.json`                   |
| Want to disable agent | `scriptpay-agent config set agents.X.enabled false`        |
| Need help             | Run `scriptpay-agent --help`                               |

## Documentation Map

```
START HERE ↓
├─ This file (overview & quick start)
│
├─ SETUP & INTEGRATION
│  └─ agent-integration-guide.md
│
├─ USING AGENTS
│  ├─ agent-cli-guide.md (commands)
│  ├─ agent-system-overview.md (architecture)
│  └─ agent-integration-guide.md (workflows)
│
├─ AGENT BEHAVIOR
│  ├─ security-agent-prompt.md
│  ├─ quality-agent-prompt.md
│  ├─ audit-agent-prompt.md
│  └─ feature-agent-prompt.md
│
├─ PROJECT DOCS
│  ├─ architecture.md (system design)
│  ├─ security.md (security requirements)
│  ├─ coding-standards.md (code conventions)
│  ├─ deployment.md (deployment)
│  └─ ...other docs...
│
└─ CLAUDE INTEGRATION
   ├─ CLAUDE.md (how Claude works with project)
   ├─ nestjs-skill.md (NestJS patterns)
   └─ security-audit-skill.md (security checklist)
```

## Quick Reference

### First Time Setup (10 minutes)

```bash
npm install -g scriptpay-agent        # Install
# Create .claude/agents.json           # Configure
export GITHUB_TOKEN=ghp_xxx            # Environment
scriptpay-agent run audit --dry-run    # Test
# Deploy .github/workflows/agents.yml  # Automate
```

### Daily (2 minutes)

```bash
scriptpay-agent prs                   # Check PRs
# Review & merge agent PRs
# Check `scriptpay-agent status`
```

### When Generating Features

```bash
scriptpay-agent feature --feature "name"   # Generate
# Review PR created
# Open in Claude Code if needed
# Merge when ready
```

## Support Resources

| Question                              | Resource                     |
| ------------------------------------- | ---------------------------- |
| How do I set up?                      | `agent-integration-guide.md` |
| How do I use CLI?                     | `agent-cli-guide.md`         |
| What does Security Agent do?          | `security-agent-prompt.md`   |
| What does Quality Agent do?           | `quality-agent-prompt.md`    |
| What does Audit Agent do?             | `audit-agent-prompt.md`      |
| How do I generate features?           | `feature-agent-prompt.md`    |
| How do I use Claude Code with agents? | `CLAUDE.md`                  |
| Project architecture?                 | `architecture.md`            |
| Security requirements?                | `security.md`                |

---

## You're All Set! 🚀

Your agent system is ready to:

- ✅ Fix security vulnerabilities automatically
- ✅ Improve code quality daily
- ✅ Monitor system health continuously
- ✅ Generate new features from roadmap
- ✅ Create PRs ready for review
- ✅ Reduce technical debt
- ✅ Keep your codebase healthy

**Start now:** See `agent-integration-guide.md` for detailed setup.

Happy automating! 🎉

---

**Created**: 2024-01-15  
**Last Updated**: 2024-01-15  
**Version**: 1.0
