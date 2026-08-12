# API Reference

## Base URL

- **Production**: `https://api.scriptpay.io/v1`
- **Staging**: `https://api-staging.scriptpay.io/v1`
- **Development**: `http://localhost:3001/v1`

## Authentication

All API requests (except `/auth/register` and `/auth/login`) require a Bearer token.

```bash
Authorization: Bearer <jwt_token>
```

### Obtaining a Token

**Request:**

```http
POST /auth/login
Content-Type: application/json

{
  "email": "merchant@example.com",
  "password": "secure_password"
}
```

**Response:**

```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiIs...",
  "refreshToken": "eyJhbGciOiJIUzI1NiIs...",
  "expiresIn": 900,
  "user": {
    "id": "user_123",
    "email": "merchant@example.com",
    "role": "merchant"
  }
}
```

### Token Refresh

**Request:**

```http
POST /auth/refresh
Content-Type: application/json

{
  "refreshToken": "eyJhbGciOiJIUzI1NiIs..."
}
```

## Common Response Format

### Success Response

```json
{
  "success": true,
  "data": {
    /* resource data */
  },
  "meta": {
    "timestamp": "2024-01-15T10:30:00Z",
    "requestId": "req_abc123"
  }
}
```

### Error Response

```json
{
  "success": false,
  "error": {
    "code": "INVALID_REQUEST",
    "message": "Payment amount must be greater than 0",
    "details": {
      "field": "amount",
      "validation": "min"
    }
  },
  "meta": {
    "timestamp": "2024-01-15T10:30:00Z",
    "requestId": "req_abc123"
  }
}
```

## Endpoints

### Transactions

#### Create Transaction

```http
POST /transactions
Authorization: Bearer <token>
Content-Type: application/json

{
  "amount": 2999,
  "currency": "USD",
  "customerEmail": "customer@example.com",
  "customerName": "John Doe",
  "description": "Order #12345",
  "paymentMethodId": "pm_123",
  "metadata": {
    "orderId": "12345",
    "invoiceId": "inv_789"
  }
}
```

**Response (201):**

```json
{
  "success": true,
  "data": {
    "id": "txn_123",
    "merchantId": "merchant_abc",
    "status": "pending",
    "amount": 2999,
    "currency": "USD",
    "stripePaymentIntentId": "pi_123",
    "customerEmail": "customer@example.com",
    "createdAt": "2024-01-15T10:30:00Z"
  }
}
```

#### List Transactions

```http
GET /transactions?limit=20&offset=0&status=succeeded&startDate=2024-01-01&endDate=2024-01-31
Authorization: Bearer <token>
```

**Response (200):**

```json
{
  "success": true,
  "data": [
    {
      "id": "txn_123",
      "status": "succeeded",
      "amount": 2999,
      "currency": "USD",
      "customerEmail": "customer@example.com",
      "createdAt": "2024-01-15T10:30:00Z"
    }
  ],
  "meta": {
    "total": 150,
    "limit": 20,
    "offset": 0,
    "hasMore": true
  }
}
```

#### Get Transaction

```http
GET /transactions/:transactionId
Authorization: Bearer <token>
```

#### Refund Transaction

```http
POST /transactions/:transactionId/refunds
Authorization: Bearer <token>
Content-Type: application/json

{
  "amount": 1500,
  "reason": "customer_request",
  "metadata": {
    "refundReason": "Item damaged"
  }
}
```

### Invoices

#### Create Invoice

```http
POST /invoices
Authorization: Bearer <token>
Content-Type: application/json

{
  "customerEmail": "customer@example.com",
  "items": [
    {
      "description": "Service A",
      "quantity": 2,
      "unitPrice": 5000
    }
  ],
  "dueDate": "2024-02-15",
  "notes": "Payment due within 30 days"
}
```

#### List Invoices

```http
GET /invoices?limit=20&status=sent
Authorization: Bearer <token>
```

#### Send Invoice

```http
POST /invoices/:invoiceId/send
Authorization: Bearer <token>
```

### Webhooks

#### List Webhook Endpoints

```http
GET /webhooks/endpoints
Authorization: Bearer <token>
```

#### Create Webhook Endpoint

```http
POST /webhooks/endpoints
Authorization: Bearer <token>
Content-Type: application/json

{
  "url": "https://example.com/webhook",
  "events": ["transaction.succeeded", "transaction.failed", "payment.refunded"],
  "active": true
}
```

#### List Webhook Events

```http
GET /webhooks/events?limit=100&status=pending
Authorization: Bearer <token>
```

#### Resend Webhook Event

```http
POST /webhooks/events/:eventId/resend
Authorization: Bearer <token>
```

### Analytics

#### Get Dashboard Metrics

```http
GET /analytics/dashboard?startDate=2024-01-01&endDate=2024-01-31
Authorization: Bearer <token>
```

**Response:**

```json
{
  "success": true,
  "data": {
    "totalVolume": {
      "amount": 50000000,
      "currency": "USD",
      "transactionCount": 1523
    },
    "successRate": 98.5,
    "averageAmount": 32840,
    "volumeByDay": [
      {
        "date": "2024-01-01",
        "amount": 1500000,
        "count": 45
      }
    ]
  }
}
```

#### Get Transaction Analytics

```http
GET /analytics/transactions?groupBy=status&startDate=2024-01-01
Authorization: Bearer <token>
```

## Error Codes

| Code                      | HTTP Status | Description                                    |
| ------------------------- | ----------- | ---------------------------------------------- |
| `INVALID_REQUEST`         | 400         | Missing or invalid request parameters          |
| `AUTHENTICATION_REQUIRED` | 401         | Missing or invalid authentication token        |
| `PERMISSION_DENIED`       | 403         | User lacks permission for this resource        |
| `NOT_FOUND`               | 404         | Resource not found                             |
| `CONFLICT`                | 409         | Resource already exists or operation conflicts |
| `RATE_LIMITED`            | 429         | Too many requests, retry after delay           |
| `SERVER_ERROR`            | 500         | Internal server error                          |
| `SERVICE_UNAVAILABLE`     | 503         | Service temporarily unavailable                |

## Rate Limiting

- **General limit**: 100 requests per minute per API key
- **Burst**: 200 requests per 10 seconds
- **Response headers**:
  ```
  X-RateLimit-Limit: 100
  X-RateLimit-Remaining: 87
  X-RateLimit-Reset: 1705328400
  ```

## Pagination

List endpoints support pagination via query parameters:

- `limit`: Number of items to return (default: 20, max: 100)
- `offset`: Number of items to skip (default: 0)
- `cursor`: Cursor-based pagination (optional)

Response includes:

- `meta.total`: Total number of items
- `meta.hasMore`: Whether more items exist
- `meta.limit`: Returned limit
- `meta.offset`: Returned offset

## Webhooks

Webhooks notify your application of events. All webhook requests:

- Use HTTP POST with JSON payload
- Include `X-Webhook-Signature` header for verification
- Retry up to 5 times with exponential backoff
- Timeout after 30 seconds

### Webhook Events

#### transaction.created

```json
{
  "event": "transaction.created",
  "data": {
    "id": "txn_123",
    "status": "pending",
    "amount": 2999
  },
  "timestamp": "2024-01-15T10:30:00Z"
}
```

#### transaction.succeeded

```json
{
  "event": "transaction.succeeded",
  "data": {
    "id": "txn_123",
    "status": "succeeded",
    "amount": 2999,
    "completedAt": "2024-01-15T10:35:00Z"
  }
}
```

### Webhook Signature Verification

```javascript
const crypto = require("crypto");

function verifyWebhookSignature(payload, signature, secret) {
  const hash = crypto.createHmac("sha256", secret).update(JSON.stringify(payload)).digest("hex");

  return hash === signature;
}
```

## Versioning

The API follows semantic versioning. The current version is `v1`.

Breaking changes increment the major version number. Current version: **v1**

## Best Practices

1. **Always use HTTPS** in production
2. **Store API keys securely** - never commit to version control
3. **Implement webhook verification** - always check signatures
4. **Handle retries gracefully** - implement exponential backoff
5. **Paginate large result sets** - don't fetch all records at once
6. **Use idempotency keys** for write operations to prevent duplicates
7. **Monitor rate limits** - implement backoff when approaching limit
8. **Log requests** for debugging and compliance
