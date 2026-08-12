# Payment Processing

## Overview

ScriptPay provides secure, reliable payment processing via Stripe integration. Merchants can accept payments globally with multiple payment methods.

## Payment Flow

### Standard Payment Flow

```
1. Customer initiates payment
2. Payment method provided (card, wallet, etc)
3. Amount & merchant info validated
4. Payment intent created with Stripe
5. Card charged (synchronous)
6. Transaction recorded (pending status)
7. Async jobs queued for settlement
8. Webhook received from Stripe
9. Transaction status updated
10. Merchant notified
11. Customer receives confirmation
```

### Error Handling

```
Payment Flow with Error Handling:

1. Amount validation fails
   └─> Return validation error immediately

2. Stripe API unavailable
   └─> Retry with exponential backoff
   └─> Timeout after 30 seconds

3. Card declined
   └─> Record transaction as failed
   └─> Send decline reason to merchant

4. Duplicate detection
   └─> Use idempotency key
   └─> Return cached result
```

## Payment Methods

### Supported Payment Methods

| Method              | Status  | Currency | Recurring | 3D Secure   |
| ------------------- | ------- | -------- | --------- | ----------- |
| Credit Card         | ✅ Live | All      | ✅        | ✅ Required |
| Debit Card          | ✅ Live | All      | ✅        | ✅ Required |
| Digital Wallets     | 🔄 Q2   | All      | ❌        | ✅          |
| Bank Transfer (ACH) | 🔄 Q2   | USD      | ✅        | ❌          |
| Wire Transfer       | 🔄 Q3   | Multiple | ❌        | ❌          |

### Card Payments

**Create card payment**:

```bash
curl -X POST http://localhost:3001/v1/transactions \
  -H "Authorization: Bearer {jwt_token}" \
  -H "Content-Type: application/json" \
  -d '{
    "amount": 2999,
    "currency": "USD",
    "paymentMethodId": "pm_card_visa",
    "customerEmail": "customer@example.com",
    "customerName": "John Doe",
    "description": "Order #12345"
  }'
```

**Response**:

```json
{
  "success": true,
  "data": {
    "id": "txn_abc123",
    "status": "succeeded",
    "amount": 2999,
    "currency": "USD",
    "paymentMethod": {
      "type": "card",
      "brand": "visa",
      "lastFour": "4242",
      "expiryMonth": 12,
      "expiryYear": 2025
    },
    "stripePaymentIntentId": "pi_xyz789",
    "createdAt": "2024-01-15T10:30:00Z"
  }
}
```

### Digital Wallets (Planned Q2)

**Apple Pay Integration**:

```javascript
// Next.js component
import { useStripe, useElements, PaymentRequestButtonElement } from "@stripe/react-stripe-js";

export const ApplePayButton = () => {
  const stripe = useStripe();
  const elements = useElements();

  const handlePaymentRequest = async (event) => {
    const { token } = await event.complete("success");
    // Create transaction with token
  };

  return (
    <PaymentRequestButtonElement
      options={{
        requestPayerName: true,
        requestPayerEmail: true,
      }}
      onReady={(paymentRequest) => {}}
      onClick={handlePaymentRequest}
    />
  );
};
```

## Transaction States

### State Machine

```
Created (initial)
├─> Pending (awaiting processing)
│   ├─> Processing (Stripe processing)
│   │   ├─> Succeeded ✓
│   │   ├─> Failed ✗
│   │   └─> Requires Action (3D Secure challenge)
│   └─> Timeout (no response after 30s)
├─> Refunded
└─> Canceled
```

### State Transitions

```typescript
// Transaction state enum
export enum TransactionStatus {
  PENDING = "pending", // Initial state
  PROCESSING = "processing", // Stripe processing
  SUCCEEDED = "succeeded", // Payment successful
  FAILED = "failed", // Payment declined/failed
  REFUNDING = "refunding", // Refund in progress
  REFUNDED = "refunded", // Refund complete
  CANCELLED = "cancelled", // User cancelled
  DISPUTED = "disputed", // Chargeback initiated
}

// Valid transitions
const validTransitions = {
  [TransactionStatus.PENDING]: [TransactionStatus.PROCESSING, TransactionStatus.CANCELLED],
  [TransactionStatus.PROCESSING]: [TransactionStatus.SUCCEEDED, TransactionStatus.FAILED],
  [TransactionStatus.SUCCEEDED]: [TransactionStatus.REFUNDING, TransactionStatus.DISPUTED],
  [TransactionStatus.REFUNDING]: [TransactionStatus.REFUNDED, TransactionStatus.FAILED],
};
```

## Amount Handling

### Precision

- **Storage**: Amounts stored in cents to avoid floating-point issues
- **Display**: Convert to dollars for UI
- **Calculation**: All math done in cents

```typescript
// Amount conversion utilities
export const dollarsToCents = (dollars: number): number => {
  return Math.round(dollars * 100);
};

export const centsToDollars = (cents: number): number => {
  return cents / 100;
};

// Usage
const amountInCents = dollarsToCents(29.99); // 2999
const amountInDollars = centsToDollars(amountInCents); // 29.99
```

### Minimum & Maximum

```
Minimum: $0.50 (50 cents)
Maximum: $99,999.99 (9,999,999 cents)
```

## Currency Support

### Supported Currencies (Live)

- USD (United States Dollar)
- EUR (Euro)
- GBP (British Pound)
- CAD (Canadian Dollar)
- AUD (Australian Dollar)
- JPY (Japanese Yen)

### Currency Handling

```typescript
// Currency utility
export const currencySettings = {
  USD: { symbol: "$", decimals: 2 },
  EUR: { symbol: "€", decimals: 2 },
  GBP: { symbol: "£", decimals: 2 },
  JPY: { symbol: "¥", decimals: 0 }, // No decimals
};

// Format currency
export const formatCurrency = (amount: number, currency: string): string => {
  const settings = currencySettings[currency];
  const formatted = (amount / 100).toFixed(settings.decimals);
  return `${settings.symbol}${formatted}`;
};
```

### Multi-Currency Transactions (Q2)

- Support multiple currencies in single transaction
- Real-time exchange rate fetching
- Settlement in preferred currency
- Detailed FX breakdown in reports

## Fees & Pricing

### Stripe Fees

- **Card Payments**: 2.2% + $0.30 per transaction
- **International**: +1% for non-USD transactions
- **ACH** (Q2): $0.80 per transaction
- **Wire** (Q3): $15.00 per transaction

### ScriptPay Markup

- **Standard**: 0.5% + $0.05
- **Volume Discount**: Negotiable at $100k+ monthly volume
- **Enterprise**: Custom pricing

### Fee Calculation Example

```
Transaction: $100.00
├─ Stripe fee: $2.30 (2.2% + $0.30)
├─ ScriptPay fee: $0.55 (0.5% + $0.05)
└─ Total deducted: $2.85
   Net to merchant: $97.15
```

## Idempotency

Protect against duplicate charges with idempotency keys.

**Request**:

```bash
curl -X POST http://localhost:3001/v1/transactions \
  -H "Authorization: Bearer {jwt_token}" \
  -H "Idempotency-Key: unique-key-12345" \
  -H "Content-Type: application/json" \
  -d '{
    "amount": 2999,
    "currency": "USD",
    "customerEmail": "customer@example.com"
  }'
```

**Idempotency Key Requirements**:

- 36 characters max
- Unique per merchant (recommended 24-hour rotation)
- Returns cached result if duplicate request received within 24 hours

**Implementation**:

```typescript
// Middleware to handle idempotency
@Injectable()
export class IdempotencyMiddleware implements NestMiddleware {
  constructor(private cache: CacheService) {}

  async use(req: Request, res: Response, next: NextFunction) {
    const key = req.headers["idempotency-key"];

    if (key && req.method === "POST") {
      const cached = await this.cache.get(`idempotency:${key}`);

      if (cached) {
        return res.status(200).json(JSON.parse(cached));
      }
    }

    next();
  }
}
```

## Refunds

### Full Refund

```bash
curl -X POST http://localhost:3001/v1/transactions/{id}/refunds \
  -H "Authorization: Bearer {jwt_token}" \
  -H "Content-Type: application/json" \
  -d '{
    "reason": "customer_request"
  }'
```

### Partial Refund

```bash
curl -X POST http://localhost:3001/v1/transactions/{id}/refunds \
  -H "Authorization: Bearer {jwt_token}" \
  -H "Content-Type: application/json" \
  -d '{
    "amount": 1000,
    "reason": "partial_refund",
    "description": "Partial credit for returned item"
  }'
```

### Refund Reasons

| Reason                           | Description                         |
| -------------------------------- | ----------------------------------- |
| `customer_request`               | Customer requested refund           |
| `duplicate`                      | Duplicate charge                    |
| `fraud`                          | Fraudulent transaction              |
| `expired_card`                   | Card expired                        |
| `recurring_transaction_canceled` | Cancelled subscription              |
| `other`                          | Other reason (requires description) |

### Refund Processing

- **Timeframe**: 5-10 business days (bank dependent)
- **Status**: Tracked in dashboard
- **Webhook**: Notified when refund settles
- **Fee**: Stripe refund fee (1% of refund amount)

## Webhooks

Payment events trigger webhooks to merchant's configured endpoint.

### Payment Events

- `transaction.created` - Transaction created
- `transaction.processing` - Payment being processed
- `transaction.succeeded` - Payment successful
- `transaction.failed` - Payment declined/failed
- `transaction.requires_action` - 3D Secure challenge needed
- `payment.refunded` - Refund processed

**Webhook payload**:

```json
{
  "event": "transaction.succeeded",
  "data": {
    "id": "txn_abc123",
    "status": "succeeded",
    "amount": 2999,
    "currency": "USD",
    "customerEmail": "customer@example.com",
    "completedAt": "2024-01-15T10:35:00Z"
  },
  "timestamp": "2024-01-15T10:35:00Z"
}
```

See [Webhooks](./webhooks.md) documentation for full details.

## Testing

### Test Mode

Use test credentials to process payments without charging.

**Test Card Numbers**:

```
4242 4242 4242 4242  - Visa (success)
4000 0000 0000 0002  - Visa (declined)
3782 822463 10005    - American Express (success)
6011 1111 1111 1117  - Discover (success)
```

**Test Mode Endpoint**:

```bash
curl -X POST http://localhost:3001/v1/transactions \
  -H "Authorization: Bearer sk_test_..." \
  -H "Content-Type: application/json"
```

### Sandbox Environment

- Separate test database
- Test Stripe account
- No real charges
- Data reset weekly

## Performance

### Optimization

- Payment processing: <1 second
- Refund processing: <500ms
- Database queries optimized with indexes
- Redis caching for frequent lookups

### Monitoring

- Transaction success rate target: 98%+
- Average processing time: <500ms
- P99 latency: <2 seconds

## Troubleshooting

### Common Issues

**"Card declined" error**

- Use test card number for testing
- Check card hasn't expired
- Verify 3D Secure if required
- Check card is not blocked by fraud detection

**"Invalid amount" error**

- Amount must be $0.50 - $99,999.99
- Amount must be in cents (integer)
- Currency must be supported

**"Transaction timeout" error**

- Retry the transaction
- Check Stripe status page
- Contact support if persists

See [Security](./security.md) for more troubleshooting and fraud prevention.
