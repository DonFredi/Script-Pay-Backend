# Authentication & Authorization

## Overview

ScriptPay implements multi-layered authentication to ensure secure access to the platform and API.

## Authentication Methods

### 1. Email & Password

Standard username/password authentication for dashboard access.

**Endpoint**: `POST /auth/login`

```bash
curl -X POST http://localhost:3001/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "merchant@example.com",
    "password": "secure_password"
  }'
```

**Response**:

```json
{
  "success": true,
  "data": {
    "accessToken": "eyJhbGciOiJIUzI1NiIs...",
    "refreshToken": "eyJhbGciOiJIUzI1NiIs...",
    "expiresIn": 900,
    "user": {
      "id": "user_123",
      "email": "merchant@example.com",
      "role": "merchant"
    }
  }
}
```

### 2. JWT (API Access)

All API requests (except auth endpoints) require Bearer token.

**Header**:

```bash
Authorization: Bearer eyJhbGciOiJIUzI1NiIs...
```

**Token Structure**:

```
Header: {
  "alg": "HS256",
  "typ": "JWT"
}

Payload: {
  "sub": "user_123",
  "email": "merchant@example.com",
  "role": "merchant",
  "iat": 1705328400,
  "exp": 1705329300
}

Signature: HMACSHA256(header.payload, secret)
```

### 3. API Keys

For server-to-server integrations.

**Header**:

```bash
Authorization: Bearer sk_test_abcdef123456
```

**Creating an API Key**:

```bash
curl -X POST http://localhost:3001/v1/api-keys \
  -H "Authorization: Bearer {jwt_token}" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Mobile App Integration",
    "scopes": ["read:transactions", "read:invoices"],
    "ipWhitelist": ["192.168.1.1", "10.0.0.0/8"]
  }'
```

### 4. OAuth2 (Planned for Q2)

Integration with third-party providers:

- Google
- GitHub
- Apple (Apple Sign In)

## Authorization

### Role-Based Access Control (RBAC)

#### Roles

| Role           | Permissions                                           | Use Case              |
| -------------- | ----------------------------------------------------- | --------------------- |
| **Admin**      | All operations, user management, system configuration | Internal staff        |
| **Merchant**   | Own transaction view, invoicing, basic analytics      | Business owner        |
| **Support**    | View all transactions, limited refund authority       | Support staff         |
| **API Client** | Limited to API key scopes                             | External integrations |

#### Permission Matrix

```
Resource          | Admin | Merchant | Support | API Client
------------------+-------+----------+---------+-----------
Users (all)       | CRUD  | -        | R       | -
Own Account       | CRUD  | RU       | R       | -
Transactions      | R     | R (own)  | R (all) | R (scoped)
Invoices          | R     | CRUD     | R (all) | R (scoped)
Analytics         | R     | R        | R       | R (scoped)
Webhooks          | R     | CRUD     | R       | -
Settings          | RU    | U (own)  | -       | -
API Keys          | R     | CRUD     | -       | -
Audit Logs        | R     | -        | -       | -
```

### Permission System Implementation

```typescript
// src/common/decorators/permission.decorator.ts
import { SetMetadata } from "@nestjs/common";

export const Permission = (...permissions: string[]) => SetMetadata("permissions", permissions);

// Usage
@Controller("transactions")
export class TransactionsController {
  @Get()
  @Permission("read:transactions")
  async list() {
    // Implementation
  }

  @Delete(":id")
  @Permission("delete:transactions")
  async delete(@Param("id") id: string) {
    // Implementation
  }
}
```

```typescript
// src/common/guards/permission.guard.ts
import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";

@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const permissions = this.reflector.get<string[]>("permissions", context.getHandler());

    if (!permissions) {
      return true; // No permissions required
    }

    const request = context.switchToHttp().getRequest();
    const user = request.user;

    if (!user) {
      throw new ForbiddenException("Not authenticated");
    }

    const hasPermission = permissions.some((permission) => user.permissions.includes(permission));

    if (!hasPermission) {
      throw new ForbiddenException("Insufficient permissions");
    }

    return true;
  }
}
```

## Session Management

### Access Token

- **Duration**: 15 minutes
- **Storage**: HttpOnly cookie (prevents XSS)
- **Refresh**: Automatic via refresh endpoint

### Refresh Token

- **Duration**: 7 days
- **Storage**: HttpOnly cookie
- **Usage**: Obtain new access token
- **Rotation**: New refresh token on each use (optional)

### Logout

- **Client-side**: Remove cookies
- **Server-side**: Add token to blacklist (Redis)
- **Blacklist TTL**: Same as token expiration time

```typescript
// src/auth/auth.service.ts
async logout(user: User): Promise<void> {
  // Add token to blacklist
  const tokenExpiry = Math.floor(Date.now() / 1000) + this.jwtExpiresIn;
  await this.redis.setex(
    `blacklist:${user.id}`,
    this.jwtExpiresIn,
    'true'
  );
}
```

## Multi-Factor Authentication (2FA)

### TOTP (Time-based One-Time Password)

**Enable 2FA**:

```bash
curl -X POST http://localhost:3001/v1/auth/2fa/enable \
  -H "Authorization: Bearer {jwt_token}" \
  -d '{ "method": "totp" }'
```

**Response** (with QR code):

```json
{
  "success": true,
  "data": {
    "secret": "JBSWY3DPEBLW64TMMQ======",
    "qrCode": "data:image/png;base64,iVBORw0KG...",
    "backupCodes": ["12345-67890", "23456-78901"]
  }
}
```

**Verify 2FA**:

```bash
curl -X POST http://localhost:3001/v1/auth/2fa/verify \
  -H "Content-Type: application/json" \
  -d '{
    "email": "merchant@example.com",
    "password": "secure_password",
    "totpCode": "123456"
  }'
```

### Email-based 2FA

**Request verification**:

```bash
curl -X POST http://localhost:3001/v1/auth/2fa/email-verify \
  -H "Content-Type: application/json" \
  -d '{ "email": "merchant@example.com" }'
```

**Verification email sent** with 6-digit code valid for 10 minutes.

## Password Security

### Requirements

- Minimum 12 characters
- Mix of uppercase, lowercase, numbers, special characters
- Not in password breach database (checked against Have I Been Pwned)

### Password Reset

**Request reset**:

```bash
curl -X POST http://localhost:3001/v1/auth/password-reset \
  -H "Content-Type: application/json" \
  -d '{ "email": "merchant@example.com" }'
```

**Reset email sent** with time-limited reset link.

**Complete reset**:

```bash
curl -X POST http://localhost:3001/v1/auth/password-reset/confirm \
  -H "Content-Type: application/json" \
  -d '{
    "token": "reset_token_from_email",
    "newPassword": "new_secure_password"
  }'
```

### Password History

- Last 5 passwords cannot be reused
- Reuse cooldown: 90 days

## API Key Management

### Creating API Keys

```bash
curl -X POST http://localhost:3001/v1/api-keys \
  -H "Authorization: Bearer {jwt_token}" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Production Integration",
    "scopes": ["read:transactions", "create:payments"],
    "ipWhitelist": ["203.0.113.1"],
    "expiresIn": 7776000
  }'
```

### Scopes

```
read:transactions   - View transaction data
create:payments     - Create payments
read:invoices       - View invoices
create:invoices     - Create invoices
read:analytics      - View analytics
manage:webhooks     - Manage webhooks
admin:all          - All permissions (use sparingly)
```

### Key Rotation

Best practice: Rotate keys every 90 days.

```bash
curl -X POST http://localhost:3001/v1/api-keys/{key_id}/rotate \
  -H "Authorization: Bearer {jwt_token}"
```

## Security Best Practices

### For Merchants

1. **Use HTTPS only** - Always use secure connections
2. **Keep tokens secret** - Never commit tokens to version control
3. **Rotate keys regularly** - Especially after suspected compromise
4. **Enable 2FA** - Mandatory for admins, recommended for merchants
5. **Monitor account access** - Review audit logs regularly
6. **Use strong passwords** - Follow password requirements

### For Developers

1. **Never log tokens** - Sanitize logs of sensitive data
2. **Use environment variables** - Store secrets in `.env`
3. **Implement CSRF protection** - Use anti-CSRF tokens
4. **Validate origins** - Check CORS headers
5. **Rate limit auth endpoints** - Prevent brute force attacks
6. **Hash passwords** - Use bcrypt with sufficient rounds

## Audit Logging

All authentication events are logged:

- Successful login
- Failed login attempts (5+ triggers alert)
- Token refresh
- Password changes
- 2FA enable/disable
- API key creation/rotation
- Permission changes

**View audit log**:

```bash
curl "http://localhost:3001/v1/audit-logs?resource=user&action=login" \
  -H "Authorization: Bearer {jwt_token}"
```

## Troubleshooting

### "Invalid Credentials" Error

- Verify email/password are correct
- Check if account is locked (5+ failed attempts)
- Account locked for 15 minutes, then auto-unlocked

### "Token Expired" Error

- Token has expired (15 min lifetime)
- Use refresh token to get new access token
- If refresh token expired, login again

### "Permission Denied" Error

- User role lacks required permission
- Contact admin to request permission upgrade

### 2FA Issues

- Ensure device clock is synced
- TOTP window is ±30 seconds
- Backup codes can be used instead
