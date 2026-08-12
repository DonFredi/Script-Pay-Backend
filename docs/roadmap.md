# Roadmap

## Vision

ScriptPay aims to be the most developer-friendly, secure payment processing platform. We're focused on providing merchants with:

- Simple, reliable payment processing
- Detailed transaction insights
- Robust security and compliance
- Excellent developer experience

## Timeline

### Q1 2024 (Current: Foundation)

**Status**: In Progress

#### Core Features (MVP)

- [x] Payment processing via Stripe
- [x] Transaction history and dashboard
- [x] Invoice generation
- [x] Webhook support
- [x] Basic analytics
- [x] API authentication (JWT)
- [x] Admin dashboard

**In Progress**

- [ ] Multi-currency support (USD, EUR, GBP)
- [ ] Payment method management
- [ ] Advanced filtering on transactions
- [ ] Email notifications

**Planned**

- [ ] 2FA for accounts
- [ ] API rate limiting dashboard
- [ ] Export transaction data (CSV, PDF)

---

### Q2 2024 (Expansion)

**Priority**: High

#### Authentication & Security

- OAuth2 integration (Google, GitHub sign-in)
- Social login for customers
- Enhanced 2FA (TOTP, SMS)
- IP whitelisting for API keys

#### Payment Features

- Subscription/recurring billing
- Payment plans and installments
- International card support
- Digital wallets (Apple Pay, Google Pay)
- Buy Now, Pay Later (BNPL) integration

#### Reporting & Analytics

- Advanced dashboard widgets
- Custom report builder
- Scheduled reports via email
- Revenue forecasting (ML-based)
- Churn analysis

**Target**: Mid-Q2

---

### Q3 2024 (Scaling)

**Priority**: Medium-High

#### Developer Tools

- Postman collection and SDK updates
- CLI tool for payment management
- Payment simulator/sandbox
- Webhook testing UI
- API performance monitoring dashboard

#### Merchant Features

- Custom branding for checkout
- Multiple merchant accounts
- Team management and permissions
- Payment customization (colors, logos)
- Batched payments processing

#### Compliance & Operations

- PCI DSS certification completion
- SOC 2 Type II audit
- Multi-language dashboard (5+ languages)
- EU VAT handling
- GDPR data export tools

**Target**: Mid-Q3

---

### Q4 2024 (Optimization)

**Priority**: Medium

#### Performance & UX

- Dashboard performance optimization
- Mobile app for merchants (iOS/Android)
- Real-time notifications (push/email/SMS)
- One-click refund processing
- Advanced search with filters

#### Analytics & Insights

- ML-powered fraud detection
- Churn prediction
- Customer lifetime value calculation
- Cohort analysis
- A/B testing framework

#### Platform Features

- White-label solution
- API for building custom dashboards
- Custom fields on transactions
- Bulk operations (refunds, cancellations)
- Dunning management for failed payments

**Target**: Mid-Q4

---

### 2025 (Enterprise & Growth)

#### Q1 2025

- [ ] Enterprise SSO (SAML/LDAP)
- [ ] Dedicated account managers
- [ ] Custom SLA agreements
- [ ] On-premises deployment option (future)
- [ ] Advanced audit logging

#### Q2 2025

- [ ] Payment routing (automatic provider selection)
- [ ] Cryptocurrency support (phase 1)
- [ ] ACH transfers integration
- [ ] Wire transfer support
- [ ] Cross-border payment optimization

#### Q3 2025

- [ ] AI-powered customer support chatbot
- [ ] Predictive risk scoring
- [ ] Marketplace/platform payments
- [ ] Multi-currency settlement
- [ ] Blockchain verification (phase 1)

#### Q4 2025

- [ ] Full cryptocurrency support
- [ ] Decentralized finance (DeFi) integration
- [ ] Global expansion to 50+ countries
- [ ] Industry-specific solutions (SaaS, e-commerce, etc.)

---

## Backlog Items

### High Priority

- [ ] ACH payment support
- [ ] Enhanced fraud detection
- [ ] Mobile app (iOS/Android)
- [ ] Real-time settlement
- [ ] Advanced reconciliation tools
- [ ] Merchant onboarding wizard

### Medium Priority

- [ ] Cryptocurrency payments
- [ ] Split payments
- [ ] Marketplace payments
- [ ] Payment orchestration
- [ ] Advanced routing rules

### Low Priority

- [ ] Loyalty program integration
- [ ] Reward system
- [ ] Peer-to-peer payments
- [ ] AI-powered recommendations

---

## Research & Exploration

### Currently Investigating

1. **Cryptocurrency Integration**
   - Payment processing in BTC, ETH, stablecoins
   - Exchange rate handling
   - Regulatory compliance

2. **Machine Learning**
   - Fraud detection improvements
   - Churn prediction
   - Revenue forecasting

3. **Platform Payments**
   - Marketplace split payments
   - Vendor payouts
   - Complex settlement scenarios

4. **Open Banking**
   - Open Banking API integration
   - Real-time account information
   - Payment initiation services

---

## Known Limitations

### Current Limitations

- Single currency per transaction (multi-currency in Q2)
- No subscription support yet (planned Q2)
- Limited webhook customization
- Dashboard limited to 1000 transactions per view

### Planned Improvements

- Pagination for unlimited transaction views
- Custom webhook filtering
- Subscription management
- International payment support

---

## Dependencies & Blockers

### External Dependencies

- **Stripe API**: Payment processing core dependency
- **AWS Infrastructure**: Hosting and database
- **PostgreSQL**: Database system

### Known Blockers

- **Regulatory Compliance**: SOC 2 audit (blocking enterprise features)
- **Infrastructure**: Kubernetes cluster upgrade (mid-Q2)
- **Third-party APIs**: Payment method integrations (dependent on provider support)

---

## Success Metrics

### By End of Q1 2024

- [ ] 50+ paying merchants
- [ ] $1M+ monthly transaction volume
- [ ] 99.9% API uptime
- [ ] <100ms average API response time

### By End of Q2 2024

- [ ] 250+ merchants
- [ ] $10M+ monthly transaction volume
- [ ] 98%+ customer satisfaction
- [ ] <50ms average API response time

### By End of 2024

- [ ] 1000+ merchants
- [ ] $100M+ annual transaction volume
- [ ] SOC 2 Type II certified
- [ ] <20 customers lost to churn

---

## Feature Request Process

Merchants can request features via:

1. **In-app feedback form** - Quick requests
2. **GitHub Discussions** - Detailed feature proposals
3. **Support tickets** - Enterprise feature requests

Top-voted features are reviewed monthly and prioritized.

### Voting Results (Last 30 days)

- Subscription support: 42 votes
- Advanced filtering: 28 votes
- Payment customization: 24 votes
- Mobile app: 19 votes
- API improvements: 17 votes

---

## Contributing to the Roadmap

Have an idea? We'd love to hear it!

1. Check if a similar feature request exists
2. Vote on existing requests
3. Create a new feature request with:
   - Use case description
   - Expected benefit
   - Estimated priority (high/medium/low)

---

## Changelog

### Recent Updates

- **Q1 2024 Week 4**: Prioritized subscription support (moved to Q2)
- **Q1 2024 Week 2**: Added cryptocurrency investigation
- **Q1 2024 Week 1**: Initial roadmap published

### Questions?

Reach out to product@scriptpay.io for roadmap discussions or strategic partnerships.
