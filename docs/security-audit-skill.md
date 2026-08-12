# Security Audit Checklist for Claude

Use this checklist when reviewing code, especially payment-related code.

## Input Validation

- [ ] All user inputs validated (length, type, format)
- [ ] SQL injection prevented (using Prisma parameterized queries)
- [ ] XSS prevention (input sanitization on frontend)
- [ ] CSRF tokens checked for state-changing requests
- [ ] File uploads restricted (type, size, scanned for malware)
- [ ] Email addresses validated
- [ ] URLs validated (prevent open redirects)
- [ ] Numbers validated (min/max, integers for amounts)

**Example to validate:**

```typescript
// ❌ BAD: No validation
@Post('transactions')
async create(@Body() dto: any) {
  // Direct use of dto without validation
}

// ✅ GOOD: Validated with DTO
@Post('transactions')
async create(@Body(new ValidationPipe()) dto: CreateTransactionDto) {
  // Validated by class-validator
}
```

## Authentication & Authorization

- [ ] Authentication required for protected endpoints
- [ ] JWT tokens have reasonable expiration (15min suggested)
- [ ] Refresh tokens have longer expiration (7d suggested)
- [ ] Tokens not stored in localStorage (use httpOnly cookies)
- [ ] Password requirements enforced (12+ chars, complexity)
- [ ] Passwords hashed with bcrypt (rounds ≥ 12)
- [ ] 2FA available for sensitive operations
- [ ] Rate limiting on login attempts
- [ ] Brute force protection (5+ failures = lockout)

**Example to validate:**

```typescript
// ❌ BAD: No rate limiting
@Post('auth/login')
async login(@Body() dto: LoginDto) {
  // No protection against brute force
}

// ✅ GOOD: Rate limiting applied
@Post('auth/login')
@UseGuards(RateLimitGuard)
async login(@Body() dto: LoginDto) {
  // Protected with rate limiting
}
```

## Data Protection

- [ ] Sensitive data encrypted at rest
- [ ] Payments use HTTPS/TLS (1.2+)
- [ ] Passwords never logged
- [ ] Tokens never logged
- [ ] API keys never logged
- [ ] Stripe keys stored in environment variables
- [ ] Database credentials not in code
- [ ] No hardcoded secrets
- [ ] Payment data never stored (tokenized via Stripe)
- [ ] PII encrypted in database

**Example to validate:**

```typescript
// ❌ BAD: Sensitive data logged
this.logger.log(`Processing payment: ${JSON.stringify(payment)}`);

// ✅ GOOD: Sensitive data redacted
this.logger.log(`Processing payment for customer`);
```

## Payment Security

- [ ] Never store full credit card data
- [ ] Use Stripe tokenization for cards
- [ ] Validate amount > 0 and < max
- [ ] Amount always in cents (integer)
- [ ] Idempotency keys for duplicate prevention
- [ ] 3D Secure enabled for international cards
- [ ] Refunds limited by original amount
- [ ] Webhook signatures verified
- [ ] Stripe webhook secret stored securely
- [ ] Payment states properly validated

**Example to validate:**

```typescript
// ❌ BAD: Storing card data
@Post('payment')
async createPayment(@Body() dto: { cardNumber: string; cvv: string }) {
  await db.save(dto); // NEVER DO THIS!
}

// ✅ GOOD: Using Stripe tokenization
@Post('payment')
async createPayment(@Body() dto: { paymentMethodId: string }) {
  const payment = await stripe.paymentIntents.create({
    amount: dto.amount,
    payment_method: dto.paymentMethodId,
  });
}
```

## Error Handling

- [ ] No sensitive data in error messages
- [ ] Stack traces hidden in production
- [ ] Error codes standardized
- [ ] Database errors not exposed
- [ ] Generic error messages to users
- [ ] Detailed errors in logs only
- [ ] Exceptions properly caught
- [ ] Timeouts implemented

**Example to validate:**

```typescript
// ❌ BAD: Leaks sensitive data
catch (error) {
  res.json({ error: error.message }); // Might leak system details
}

// ✅ GOOD: Generic error message
catch (error) {
  this.logger.error(`Payment failed: ${error.message}`);
  res.json({ error: 'Payment processing failed' });
}
```

## Database Security

- [ ] Row-level security for audit logs
- [ ] SQL injection prevention (Prisma ORM)
- [ ] No union-based queries on user data
- [ ] Database backups encrypted
- [ ] Connection using SSL/TLS
- [ ] Database in private VPC (no internet access)
- [ ] Prepared statements for all queries
- [ ] Database user has least privilege

**Example to validate:**

```typescript
// ❌ BAD: Using string interpolation
const query = `SELECT * FROM users WHERE id = ${id}`;

// ✅ GOOD: Using Prisma (parameterized)
const user = await prisma.user.findUnique({
  where: { id }, // Parameterized query
});
```

## API Security

- [ ] Rate limiting enabled
- [ ] CORS properly configured
- [ ] CSRF protection for state-changing requests
- [ ] Security headers set (HSTS, CSP, etc)
- [ ] API versioning in place
- [ ] Deprecation timeline communicated
- [ ] API keys rotated regularly
- [ ] API keys have scopes/permissions

**Example to validate:**

```typescript
// ❌ BAD: CORS too permissive
app.use(cors()); // Allows any origin

// ✅ GOOD: CORS restricted
app.use(
  cors({
    origin: ["https://example.com"],
    credentials: true,
  }),
);
```

## Logging & Monitoring

- [ ] Security events logged (login attempts, permission changes)
- [ ] Audit trail maintained (1+ year)
- [ ] Failed requests logged
- [ ] Sensitive data redacted from logs
- [ ] Logs encrypted at rest
- [ ] Log retention policy enforced
- [ ] Anomalies detected and alerted
- [ ] Access logs for sensitive operations

**Example to validate:**

```typescript
// ✅ GOOD: Security events logged
this.auditLog.create({
  action: "transaction_refunded",
  userId: user.id,
  transactionId: txn.id,
  timestamp: new Date(),
});
```

## Dependencies

- [ ] npm audit passes (no high severity)
- [ ] Dependencies regularly updated
- [ ] No deprecated packages used
- [ ] License compliance checked
- [ ] Vulnerable packages removed
- [ ] Dependency versions pinned
- [ ] Supply chain security (GitHub token, NPM token)

**Commands to run:**

```bash
npm audit
npm outdated
npm list | grep deprecated
```

## Infrastructure

- [ ] HTTPS enforced (HTTP redirects to HTTPS)
- [ ] SSL certificate valid and up-to-date
- [ ] TLS 1.2+ only (no SSL 3.0, TLS 1.0, 1.1)
- [ ] Security groups restrict access
- [ ] Network segmentation (private VPC)
- [ ] Secrets Manager used for credentials
- [ ] No public S3 buckets with sensitive data
- [ ] Database backups encrypted

## Code Review Checklist

When reviewing any code:

### General

- [ ] Input validation present
- [ ] Error handling appropriate
- [ ] No hardcoded secrets
- [ ] Follows coding standards
- [ ] Well-tested

### Payments

- [ ] Using Stripe properly
- [ ] Amounts always in cents
- [ ] Idempotency implemented
- [ ] Webhook verification in place
- [ ] PCI compliance maintained

### Authentication

- [ ] Permissions checked
- [ ] JWT validation present
- [ ] Rate limiting applied
- [ ] Sensitive logs redacted

### Database

- [ ] Parameterized queries
- [ ] Indexes on filtered columns
- [ ] N+1 queries prevented
- [ ] Transaction boundaries correct

### Frontend

- [ ] XSS prevention (no innerHTML)
- [ ] CSRF tokens used
- [ ] Sensitive data not in localStorage
- [ ] Tokens stored in httpOnly cookies

## Quick Audit Flow

For a payment-related feature:

1. **Input Validation** ✓
   - Check DTOs have proper validators
   - Verify amount validation (>0, <max)

2. **Authentication** ✓
   - Verify guard/decorator applied
   - Check permissions if needed

3. **Payment Logic** ✓
   - Verify Stripe integration correct
   - Check idempotency key usage
   - Validate amount formatting (cents)

4. **Error Handling** ✓
   - Verify no data leakage
   - Check appropriate error codes

5. **Logging** ✓
   - Verify sensitive data redacted
   - Check audit trail captured

6. **Database** ✓
   - Use Prisma (parameterized)
   - Verify transaction boundaries
   - Check error handling

## Red Flags to Catch

🚩 **Never Approve If:**

- [ ] Sensitive data logged
- [ ] Hardcoded secrets/keys
- [ ] No input validation
- [ ] Direct SQL queries
- [ ] Card data stored
- [ ] No error handling
- [ ] Unencrypted sensitive data
- [ ] No webhook verification
- [ ] Exposed database details

## Questions to Ask

When reviewing payment code:

1. Is user input validated?
2. Could this expose sensitive data?
3. Are credentials/keys secure?
4. Is error handling appropriate?
5. Is Stripe integration correct?
6. Could this be exploited?
7. Are there timing attacks possible?
8. Is audit trail maintained?

## Resources

- OWASP Top 10: https://owasp.org/Top10/
- PCI DSS: https://www.pcisecuritystandards.org/
- Stripe Security: https://stripe.com/docs/security
- See `docs/security.md` for full security documentation
