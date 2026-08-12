# Claude Integration Guide

This file helps Claude understand the ScriptPay project structure and how to best assist with development.

## Project Overview

**ScriptPay** is a modern payment processing platform built with:

- **Backend**: NestJS with TypeScript
- **Frontend**: Next.js 14+ with React
- **Database**: PostgreSQL with Prisma ORM
- **Infrastructure**: Kubernetes with Docker containers
- **Payment Processing**: Stripe integration

## Key Technologies

### Backend Stack

- `@nestjs/core` - NestJS framework
- `@nestjs/typeorm` - Database ORM (using Prisma)
- `passport` - Authentication
- `stripe` - Payment processing
- `@nestjs/swagger` - API documentation

### Frontend Stack

- `next.js` - React framework
- `react` - UI library
- `@stripe/react-stripe-js` - Stripe integration
- `tailwindcss` - Styling
- `swr` - Data fetching

### Infrastructure

- Kubernetes for orchestration
- Docker for containerization
- PostgreSQL for database
- Redis for caching/sessions

## Project Structure

```
scriptpay/
├── apps/
│   ├── api/              # NestJS backend
│   │   ├── src/
│   │   │   ├── auth/
│   │   │   ├── transactions/
│   │   │   ├── invoices/
│   │   │   ├── webhooks/
│   │   │   ├── analytics/
│   │   │   ├── common/    # Shared utilities
│   │   │   └── app.module.ts
│   │   └── prisma/
│   │
│   ├── dashboard/        # Next.js frontend
│   │   ├── src/
│   │   │   ├── app/     # Pages (App Router)
│   │   │   ├── components/
│   │   │   ├── hooks/
│   │   │   ├── lib/
│   │   │   ├── services/
│   │   │   └── types/
│   │   └── public/
│   │
│   └── docs/            # Documentation site
│
├── packages/            # Shared code
│   ├── shared/          # Shared types and utilities
│   └── sdk/             # JavaScript SDK
│
├── docs/                # Project documentation
│   ├── architecture.md
│   ├── database.md
│   ├── api.md
│   ├── security.md
│   ├── coding-standards.md
│   ├── deployment.md
│   ├── decisions.md
│   ├── roadmap.md
│   └── features/
│       ├── authentication.md
│       ├── payments.md
│       ├── transactions.md
│       ├── analytics.md
│       ├── invoices.md
│       ├── clients.md
│       ├── billing.md
│       └── webhooks.md
│
├── .claude/             # Claude-specific configuration
│   ├── CLAUDE.md       # This file
│   ├── prompts/        # Reusable prompts
│   └── skills/         # Claude skills for specific tasks
│
├── prisma/
│   ├── schema.prisma
│   └── migrations/
│
├── k8s/                # Kubernetes manifests
├── docker-compose.yml
├── package.json
└── README.md
```

## Common Tasks & Prompts

### When Working on Backend Features

**Start with:**

1. Read relevant doc in `docs/features/` (e.g., `payments.md`)
2. Review `docs/architecture.md` for system design
3. Check `docs/coding-standards.md` for NestJS conventions
4. Refer to appropriate `.claude/skills/` file

**Example**: Working on payment processing:

```
I'm adding X-Pay support to ScriptPay. Review the payment flow
in docs/features/payments.md and current Stripe integration.
What architectural changes are needed?
```

### When Working on Frontend

**Start with:**

1. Review `docs/architecture.md` for design
2. Check `docs/features/` for feature specs
3. Reference `.claude/skills/nextjs.md` for conventions
4. Look at `docs/coding-standards.md` for React patterns

**Example**: Building transaction dashboard:

```
I'm building the transaction dashboard in Next.js.
Review docs/features/transactions.md and the API endpoints
in docs/api.md. What data fetching strategy should I use?
```

### Security Review

**Always reference:**

1. `docs/security.md` - Comprehensive security guide
2. `.claude/skills/security-audit.md` - Security checklist
3. `docs/coding-standards.md` - Secure coding practices

**Example**: Reviewing payment handling:

```
Review this payment handling code against the security
checklist in .claude/skills/security-audit.md and
docs/security.md. Are there any vulnerabilities?
```

### Code Review

**Reference:**

1. `docs/coding-standards.md` - All standards
2. `.claude/skills/payment-review.md` - Payment-specific review
3. `.claude/skills/nestjs.md` - Backend patterns
4. `.claude/skills/nextjs.md` - Frontend patterns

## Key Concepts

### Authentication

- JWT tokens with 15-minute expiry
- Refresh tokens with 7-day expiry
- Role-based access control (RBAC)
- API keys for server-to-server integration
- See `docs/features/authentication.md`

### Payment Flow

- Synchronous: Validation → Stripe API → Database update
- Asynchronous: Event queue → Webhook delivery → Analytics
- See `docs/features/payments.md`

### Database Design

- PostgreSQL with Prisma ORM
- All amounts in cents (integers)
- Soft deletes for users (deleted_at)
- Audit logging for compliance
- See `docs/database.md`

### API Architecture

- REST API with JWT authentication
- Versioned endpoints (`/v1/`, `/v2/`, etc.)
- Consistent error responses
- Rate limiting (100 req/min default)
- See `docs/api.md`

## Files Claude Should Know About

### Always Reference

- `docs/architecture.md` - System design
- `docs/coding-standards.md` - Code conventions
- `docs/security.md` - Security requirements
- `docs/database.md` - Schema and queries

### When Working on Features

- `docs/features/{feature}.md` - Specific feature documentation
- `docs/api.md` - API endpoint specifications
- `docs/decisions.md` - Architectural decisions

### When Deploying

- `docs/deployment.md` - Deployment procedures
- `docs/security.md` - Security checklist
- `k8s/` - Kubernetes manifests

## Claude Skills

### Available Skills

- `.claude/skills/nestjs.md` - NestJS patterns and best practices
- `.claude/skills/nextjs.md` - Next.js patterns and best practices
- `.claude/skills/prisma.md` - Prisma ORM patterns
- `.claude/skills/payment-review.md` - Payment-specific code review
- `.claude/skills/security-audit.md` - Security audit checklist

## Writing Prompts for Claude

### Good Prompt Structure

```
Task: [What you want to accomplish]

Context: [Relevant project context]
- Reading docs/features/payments.md for payment flow
- Building on existing Stripe integration

Constraints:
- Must follow NestJS patterns from docs/coding-standards.md
- Payment amounts must be handled in cents
- Must include proper error handling

Output:
- [What you want Claude to produce]
```

### Example Good Prompts

**Bad**: "How do I process a payment?" **Good**: "I need to add PayPal support to ScriptPay alongside existing Stripe integration. Review the payment flow in docs/features/payments.md and docs/decisions.md (ADR-005). What changes to the payment service and database schema are needed?"

**Bad**: "Review my code" **Good**: "Review this refund endpoint implementation against the security checklist in .claude/skills/security-audit.md and coding-standards.md. Check for: proper authentication, input validation, error handling, and PCI compliance."

## Useful Commands

```bash
# Explore the documentation
cat docs/architecture.md          # System overview
cat docs/features/payments.md     # Payment feature details
cat docs/coding-standards.md      # Code conventions

# Read current prompts
ls .claude/prompts/

# Check relevant skills
cat .claude/skills/nestjs.md
cat .claude/skills/security-audit.md
```

## Common Questions Claude Can Help With

- ✅ Code review against standards
- ✅ Architecture questions
- ✅ NestJS/Next.js patterns
- ✅ Database design and queries
- ✅ Security implementation
- ✅ API endpoint design
- ✅ Testing strategies
- ✅ Deployment procedures
- ✅ Payment processing logic
- ✅ Webhook handling

## What to Avoid

- ❌ Don't skip reading relevant documentation
- ❌ Don't violate coding standards without good reason
- ❌ Don't implement payment logic without security review
- ❌ Don't commit secrets to version control
- ❌ Don't skip security checklist for sensitive features
- ❌ Don't modify database schema without migration

## Integration Tips

### For Daily Development

1. Quickly check relevant feature doc
2. Reference coding standards
3. Ask Claude for specific patterns
4. Always security-review payment code
5. Test against requirements

### For Code Review

1. Load coding standards
2. Load security checklist
3. Have Claude review against both
4. Request specific pattern validation

### For Architecture Decisions

1. Read architecture.md
2. Check decisions.md
3. Review relevant ADRs
4. Ask Claude to propose new ADR if needed

## Documentation Standards

All documentation in `docs/` follows these conventions:

- Markdown format
- Clear headings (H1, H2, H3)
- Code examples where applicable
- Links to related documentation
- Practical examples before theoretical explanations

When Claude writes documentation, it should follow these standards.

## Updates to This File

As new features are added or patterns emerge:

1. Update relevant feature docs in `docs/features/`
2. Update coding standards if new patterns emerge
3. Update architecture if major changes occur
4. Update this file if new skills or prompts are added
5. Create new ADRs for architectural decisions

## Questions?

If something isn't clear:

1. Check the specific feature documentation
2. Review coding standards
3. Look at existing code examples
4. Ask Claude based on context

---

**Last Updated**: 2024-01-15 **Version**: 1.0
