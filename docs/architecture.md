## System Overview

ScriptPay is a payment processing platform built with a microservices-ready architecture using NestJS backend and Next.js frontend, designed for scalability, security, and reliability.

```
┌─────────────────────────────────────────────────────────────┐
│                    Next.js Dashboard                        │
│              (Admin & Merchant Portal)                      │
└────────────────┬────────────────────────────────────────────┘
                 │ (REST/GraphQL API)
┌────────────────▼────────────────────────────────────────────┐
│                  NestJS API Gateway                          │
│  (Authentication, Rate Limiting, Request Routing)           │
└────────────────┬────────────────────────────────────────────┘
                 │
    ┌────────────┼────────────┬──────────────┐
    │            │            │              │
┌───▼──┐  ┌──────▼───┐  ┌─────▼────┐  ┌────▼────┐
│Auth  │  │ Payments │  │ Analytics│  │ Billing │
│Svc   │  │   Svc    │  │   Svc    │  │   Svc   │
└───┬──┘  └──────┬───┘  └─────┬────┘  └────┬────┘
    │            │            │            │
    └────────────┼────────────┼────────────┘
                 │
        ┌────────▼─────────┐
        │  PostgreSQL DB   │
        │  (Prisma ORM)    │
        └──────────────────┘
```

## Core Services

### Authentication Service

- JWT-based token management
- OAuth2 provider integration (Google, GitHub)
- Role-based access control (RBAC)# Architecture

- Session management and token refresh

### Payment Service

- Stripe integration for payment processing
- PCI DSS compliance through tokenization
- Payment method management
- Recurring billing support

### Transaction Service

- Transaction history and ledger
- Payment state machine (pending → processing → completed/failed)
- Audit logging
- Reconciliation with payment providers

### Analytics Service

- Real-time metrics collection
- Historical data aggregation
- Custom reporting endpoints
- Dashboard widget data feeds

### Billing Service

- Invoice generation
- Subscription management
- Refund processing
- Usage-based billing calculations

## Database Design

PostgreSQL with Prisma ORM handles:

- User and merchant accounts
- Payment records
- Transaction history
- Analytics data
- Billing records

See [Database](./database.md) for full schema.

## Communication Patterns

### Synchronous

- REST APIs for client-facing operations
- Internal service-to-service calls via HTTP

### Asynchronous

- Event queues for payment processing
- Webhook delivery to merchants
- Batch analytics processing

## Deployment Architecture

### Development

- Local PostgreSQL instance
- NestJS dev server on port 3001
- Next.js dev server on port 3000

### Staging

- Docker containers orchestrated with Docker Compose
- Separate PostgreSQL database
- SSL/TLS enabled

### Production

- Kubernetes cluster
- Multiple replicas for each service
- PostgreSQL RDS with replication
- Redis for caching and job queues
- CloudFront CDN for Next.js assets

See [Deployment](./deployment.md) for detailed instructions.

## Security Architecture

- API Gateway performs authentication and authorization
- JWT tokens with short expiration (15min) + refresh tokens (7d)
- Rate limiting per API key and IP
- CORS configured for allowed origins
- All payment data encrypted at rest
- TLS 1.2+ for all transport
- WAF (Web Application Firewall) on production

See [Security](./security.md) for comprehensive details.

## Data Flow Examples

### Payment Processing Flow

```
1. Merchant submits payment via dashboard
2. Next.js frontend validates and sends to API
3. NestJS API authenticates request
4. Payment Service receives payment details
5. Stripe tokenization (secure PCI handling)
6. Payment intent created with Stripe
7. Transaction record created (pending)
8. Async job queued for processing
9. Webhook from Stripe updates transaction status
10. Analytics Service ingests transaction event
11. Merchant receives webhook notification
```

### Authentication Flow

```
1. User logs in via Next.js form
2. Credentials sent to /auth/login endpoint
3. Auth Service validates and creates JWT
4. Token returned to frontend
5. Frontend stores in httpOnly cookie
6. Subsequent requests include JWT
7. API Gateway validates token
8. Request passed to appropriate service
```

## Performance Considerations

### Caching

- Redis for session storage
- API response caching (10-60s TTL)
- Dashboard state caching on frontend

### Database Optimization

- Indexes on frequently queried columns (user_id, merchant_id, created_at)
- Read replicas for analytics queries
- Connection pooling via Prisma

### API Performance

- Pagination for list endpoints (default 20, max 100)
- Lazy loading on Next.js frontend
- CDN for static assets

## Scaling Strategy

### Horizontal Scaling

- Stateless NestJS services behind load balancer
- Database query optimization for analytics service
- Separate read replica for reporting

### Vertical Scaling

- Increase pod resources as needed
- Database connection pool tuning

### Future Considerations

- Event sourcing for payment history immutability
- CQRS pattern for analytics queries
- Shard database by merchant_id for multi-tenant scaling
