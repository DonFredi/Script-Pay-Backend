# Security

## Overview

ScriptPay handles sensitive financial data and must maintain the highest security standards. This document outlines our security practices, compliance requirements, and threat mitigation strategies.

## Compliance

### PCI DSS

- **Level**: Stripe handles payment processing, ScriptPay maintains Level 1 compliance
- **Responsibility**: Never store full credit card data; use Stripe tokenization
- **Validation**: Annual audits required
- **Status**: Currently compliant via Stripe partnership

### GDPR

- **Data Processing**: User data covered by DPA with Stripe
- **Right to Erasure**: Soft-delete implemented with 90-day purge
- **Consent**: Explicit opt-in for marketing communications
- **Breach Notification**: Required within 72 hours to authorities

### SOC 2 Type II

- Target: Achieve certification within 12 months
- Audits: Annual Type II audits once certified

## Authentication & Authorization

### Password Security

```
- Minimum 12 characters
- Mix of uppercase, lowercase, numbers, special characters
- SHA-256 hashing with bcrypt (salt rounds: 12)
- Password history: prevent reusing last 5 passwords
- Expiration: optional (recommended every 90 days)
```

### Session Management

```javascript
// JWT Configuration
{
  algorithm: 'HS256',
  accessTokenExpiry: '15 minutes',
  refreshTokenExpiry: '7 days',
  issuer: 'scriptpay.io',
  audience: 'scriptpay-api'
}
```

### Multi-Factor Authentication

- 2FA enabled for admin accounts (mandatory)
- 2FA available for merchants (optional, recommended)
- Supported methods:
  - Time-based One-Time Password (TOTP)
  - Email-based verification
  - SMS (future)

### API Key Management

- Keys generated with 64-byte random entropy
- Stored as salted hashes in database (never plaintext)
- Rotation recommended every 90 days
- API key scopes limit endpoint access
- Keys tied to specific IP ranges (optional)

## Data Protection

### Encryption at Rest

```
- PostgreSQL: Transparent Data Encryption (TDE) enabled
- Backups: AES-256 encryption
- Stripe keys: Encrypted in application configuration
- Database credentials: Stored in AWS Secrets Manager
```

### Encryption in Transit

```
- TLS 1.2+ mandatory for all connections
- Certificate: Let's Encrypt with auto-renewal
- HSTS: strict-transport-security: max-age=31536000; includeSubDomains
- Certificate pinning: Recommended for mobile clients (future)
```

### Data Classification

```
PUBLIC:    Website content, general documentation
INTERNAL:  Architecture docs, incident reports
SENSITIVE: API keys, database credentials, encryption keys
RESTRICTED: PII, payment data, audit logs
```

### PII Handling

- Email addresses and names stored encrypted
- Phone numbers hashed
- Social security numbers: NOT stored
- Payment methods: Tokenized via Stripe
- Data access logs: Maintain 1-year audit trail

## API Security

### Rate Limiting

```
- 100 requests/minute per API key (general)
- 50 requests/minute for auth endpoints
- 1000 requests/minute for analytics queries
- Burst protection: 200 requests/10 seconds
```

### CORS Configuration

```javascript
// Allowed Origins
const allowedOrigins = ["https://dashboard.scriptpay.io", "https://app.scriptpay.io"];

// Allowed Methods
["GET", "POST", "PUT", "DELETE"];

// Credentials
credentials: true;
```

### Input Validation

- All inputs validated against schema
- XSS protection via input sanitization
- SQL injection prevention via Prisma ORM
- File upload restrictions (type, size, malware scan)

### Output Encoding

- JSON responses properly encoded
- Error messages don't leak sensitive data
- Stack traces hidden in production

### CSRF Protection

- CSRF tokens included in state-changing requests
- Token validation on server-side
- SameSite cookies: Strict

## Infrastructure Security

### API Gateway

- AWS API Gateway with WAF
- DDoS protection via AWS Shield
- Request validation and rate limiting
- IP whitelisting (internal services)

### Database Security

```
- PostgreSQL 14+
- Authentication: Username + password
- Authorization: Row-level security for audit logs
- Connection: SSL/TLS encrypted
- Network: Private VPC, no internet access
- Backup: 30-day retention, encrypted, tested monthly
```

### Secrets Management

- AWS Secrets Manager for all credentials
- Automatic rotation enabled for database passwords
- Application config via environment variables
- Never log sensitive values

### Network Security

```
- Production: Private VPC with no internet gateway
- NAT Gateway: For outbound connections
- Security Groups: Least privilege principle
- Network ACLs: Explicit allow rules
- VPN: Required for admin access
```

### Server Security

```
- OS: Ubuntu 22.04 LTS, hardened
- Firewall: UFW enabled, port 443/80 only
- Patching: Automated monthly
- Monitoring: CloudWatch, Security Hub
- Logging: ELK stack for aggregation
```

## Monitoring & Logging

### Audit Logging

- All data changes logged: user, timestamp, action, changes
- Login attempts: succeeded and failed
- API key usage: endpoint, IP, timestamp
- Admin actions: full audit trail
- Retention: 1 year
- Immutable: No deletion, only archival

### Security Monitoring

```javascript
// Events triggering alerts
- Multiple failed login attempts (5+ in 15 min)
- API key creation/rotation
- Permission changes
- Bulk data exports
- Payment amount anomalies
- Failed security checks
```

### Incident Response

1. **Detection**: CloudWatch alarms + manual review
2. **Isolation**: Affected systems quarantined
3. **Assessment**: Severity determination
4. **Notification**: Affected users within 4 hours
5. **Remediation**: Fix implemented
6. **Post-mortem**: Within 24 hours of resolution

### Log Management

```
- Logs retained: 90 days hot, 1 year cold storage
- Encryption: All logs encrypted
- Access: Via CloudTrail audit only
- Scrubbing: Sensitive data redacted
- Retention policy: Compliant with GDPR
```

## Dependency Management

### Vulnerability Scanning

- `npm audit` run on every commit (CI/CD)
- Snyk integration for continuous monitoring
- Automated PRs for non-breaking updates
- Manual review for breaking updates
- Quarterly security audits

### Approved Dependencies

- Regular review: quarterly
- License compliance: Apache 2.0, MIT preferred
- Risk assessment: security + maintenance status
- Deprecated packages: removed within 30 days

## Threat Scenarios

### Account Compromise

- **Detection**: Login from unusual location/device
- **Response**: Session termination, password reset required
- **Prevention**: 2FA, email verification, rate limiting

### SQL Injection

- **Prevention**: Prisma ORM parameterized queries
- **Detection**: WAF rules, log monitoring
- **Testing**: OWASP Top 10 penetration testing

### DDoS Attack

- **Prevention**: AWS Shield, CloudFlare DDoS protection
- **Detection**: Traffic anomaly detection
- **Response**: Auto-scaling, rate limiting

### Payment Fraud

- **Detection**: Amount anomalies, velocity checks
- **Prevention**: Stripe 3D Secure, CVV validation
- **Response**: Transaction decline, account review

### Data Breach

- **Prevention**: Encryption, access controls, monitoring
- **Detection**: Intrusion detection system alerts
- **Response**: Incident response plan (see above)

## Third-Party Security

### Stripe Integration

- Uses Stripe PCI compliance (not our responsibility)
- API key stored in Secrets Manager
- Webhook signature verification required
- Limited scopes (test mode for development)

### External Dependencies

- GitHub: 2FA required, branch protection rules
- AWS: Root account disabled, MFA enforced
- NPM: Token-based auth, limited scope tokens

## Security Checklist

### Before Deployment

- [ ] Security review completed
- [ ] OWASP Top 10 validation passed
- [ ] Penetration testing done
- [ ] Secrets not committed (git-secrets)
- [ ] SAST scan passed (SonarQube)
- [ ] Dependencies audited (npm audit)
- [ ] Logging implemented
- [ ] Rate limiting configured
- [ ] CORS properly set
- [ ] Error handling doesn't leak data

### During Development

- [ ] Secrets in `.env`, not `.env.example`
- [ ] Validate all inputs
- [ ] Sanitize all outputs
- [ ] Use HTTPS in dev (localhost certificate)
- [ ] Log security-relevant events
- [ ] Regular vulnerability scans
- [ ] Keep dependencies updated

### Incident Response

- [ ] Incident severity determined
- [ ] Affected systems isolated
- [ ] Incident lead appointed
- [ ] Stakeholders notified
- [ ] Root cause analysis performed
- [ ] Fix implemented and tested
- [ ] Communication sent to affected parties
- [ ] Post-incident review scheduled

## Reporting Security Issues

**DO NOT** create public GitHub issues for security vulnerabilities.

1. Email: `security@scriptpay.io`
2. Include:
   - Vulnerability description
   - Affected component/endpoint
   - Reproduction steps
   - Potential impact
   - Suggested fix (optional)

3. We will:
   - Acknowledge within 24 hours
   - Triage within 48 hours
   - Provide status updates weekly
   - Coordinate fix and disclosure timeline
   - Credit finder in advisory (unless declined)

## Resources

- [OWASP Top 10](https://owasp.org/Top10/)
- [PCI DSS Compliance](https://www.pcisecuritystandards.org/)
- [GDPR Requirements](https://gdpr.eu/)
- [AWS Security Best Practices](https://docs.aws.amazon.com/security/)
- [Node.js Security Best Practices](https://nodejs.org/en/docs/guides/security/)
