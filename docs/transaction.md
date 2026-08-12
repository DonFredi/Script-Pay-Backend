# Transactions & History

## Overview

ScriptPay maintains a complete audit trail of all payment transactions for merchants. All transactions are immutable and can be searched, filtered, and exported.

## Transaction Structure

```typescript
interface Transaction {
  // Identifiers
  id: string; // Unique transaction ID
  merchantId: string; // Merchant who processed
  stripePaymentIntentId: string; // Stripe payment intent reference

  // Amount & Currency
  amount: number; // Amount in cents
  currency: string; // ISO 4217 code (USD, EUR, etc)

  // Status
  status: TransactionStatus; // pending, succeeded, failed, etc

  // Customer Info
  customerEmail: string;
  customerName: string;

  // Details
  description: string; // Transaction description
  metadata: Record<string, any>; // Custom data

  // Payment Method
  paymentMethod: {
    type: string; // card, bank_account, wallet
    brand: string; // visa, mastercard, etc
    lastFour: string; // Last 4 digits
  };

  // Failure Info
  failureReason?: string; // Reason if failed
  failureCode?: string; // Stripe failure code

  // Timestamps
  createdAt: string; // ISO 8601 timestamp
  updatedAt: string;
  completedAt?: string; // When payment settled
}
```

## Querying Transactions

### List Transactions

```bash
curl "http://localhost:3001/v1/transactions?limit=20&offset=0&status=succeeded" \
  -H "Authorization: Bearer {jwt_token}"
```

**Query Parameters**:

```
limit        - Number of results (1-100, default 20)
offset       - Skip N results (default 0)
status       - Filter by status (succeeded, failed, pending)
startDate    - ISO 8601 date (e.g., 2024-01-01)
endDate      - ISO 8601 date
sortBy       - Field to sort (createdAt, amount)
sortOrder    - asc or desc (default: desc)
search       - Search by email or description
```

**Response**:

```json
{
  "success": true,
  "data": [
    {
      "id": "txn_123",
      "amount": 2999,
      "status": "succeeded",
      "customerEmail": "customer@example.com",
      "createdAt": "2024-01-15T10:30:00Z"
    }
  ],
  "meta": {
    "total": 542,
    "limit": 20,
    "offset": 0,
    "hasMore": true
  }
}
```

### Get Transaction Details

```bash
curl "http://localhost:3001/v1/transactions/{transaction_id}" \
  -H "Authorization: Bearer {jwt_token}"
```

**Response**:

```json
{
  "success": true,
  "data": {
    "id": "txn_123",
    "merchantId": "merchant_abc",
    "amount": 2999,
    "currency": "USD",
    "status": "succeeded",
    "customerEmail": "customer@example.com",
    "customerName": "John Doe",
    "description": "Order #12345",
    "paymentMethod": {
      "type": "card",
      "brand": "visa",
      "lastFour": "4242"
    },
    "metadata": {
      "orderId": "order_123",
      "invoiceId": "inv_456"
    },
    "createdAt": "2024-01-15T10:30:00Z",
    "completedAt": "2024-01-15T10:35:00Z"
  }
}
```

## Filtering & Search

### Common Filters

```typescript
// By date range
GET /transactions?startDate=2024-01-01&endDate=2024-01-31

// By status
GET /transactions?status=succeeded
GET /transactions?status=failed

// By customer
GET /transactions?search=customer@example.com

// By amount range
GET /transactions?minAmount=1000&maxAmount=50000

// By payment method
GET /transactions?paymentMethod=card

// Combined filters
GET /transactions?status=succeeded&startDate=2024-01-01&limit=50&sortBy=amount&sortOrder=desc
```

### Advanced Search

```typescript
// Full-text search (email, name, description)
GET /transactions?search=john

// Metadata search (requires exact match)
GET /transactions?metadata.orderId=12345

// Date + Status + Amount
GET /transactions?status=succeeded&startDate=2024-01-01&minAmount=5000
```

## Analytics & Reporting

### Transaction Summary

```bash
curl "http://localhost:3001/v1/transactions/summary?startDate=2024-01-01&endDate=2024-01-31" \
  -H "Authorization: Bearer {jwt_token}"
```

**Response**:

```json
{
  "success": true,
  "data": {
    "totalVolume": 150000, // cents
    "transactionCount": 50,
    "successRate": 98.0, // percentage
    "failureCount": 1,
    "averageAmount": 3000, // cents
    "medianAmount": 2500,
    "minAmount": 500,
    "maxAmount": 50000,
    "volumeByStatus": {
      "succeeded": 147000,
      "failed": 3000,
      "pending": 0
    },
    "volumeByPaymentMethod": {
      "card": 148000,
      "wallet": 2000
    }
  }
}
```

## Exporting Transactions

### CSV Export

```bash
curl "http://localhost:3001/v1/transactions/export?format=csv&startDate=2024-01-01&endDate=2024-01-31" \
  -H "Authorization: Bearer {jwt_token}" \
  > transactions.csv
```

**CSV Format**:

```
Transaction ID,Date,Customer Email,Amount,Currency,Status,Payment Method,Description
txn_123,2024-01-15T10:30:00Z,customer@example.com,29.99,USD,succeeded,visa,Order #12345
txn_124,2024-01-15T10:35:00Z,customer2@example.com,49.99,USD,succeeded,card,Order #12346
```

### JSON Export

```bash
curl "http://localhost:3001/v1/transactions/export?format=json&startDate=2024-01-01" \
  -H "Authorization: Bearer {jwt_token}" \
  > transactions.json
```

### PDF Report

```bash
curl "http://localhost:3001/v1/transactions/export?format=pdf&startDate=2024-01-01&endDate=2024-01-31" \
  -H "Authorization: Bearer {jwt_token}" \
  > transactions_report.pdf
```

## Disputes & Chargebacks

### Dispute Status

```typescript
enum DisputeStatus {
  UNDER_REVIEW = "under_review",
  EVIDENCE_REQUIRED = "evidence_required",
  EVIDENCE_SUBMITTED = "evidence_submitted",
  CLOSED = "closed",
  WON = "won",
  LOST = "lost",
}
```

### Getting Dispute Information

```bash
curl "http://localhost:3001/v1/transactions/{transaction_id}/dispute" \
  -H "Authorization: Bearer {jwt_token}"
```

**Response**:

```json
{
  "success": true,
  "data": {
    "id": "dispute_123",
    "transactionId": "txn_456",
    "status": "evidence_required",
    "reason": "fraudulent",
    "amount": 2999,
    "currency": "USD",
    "deadline": "2024-01-22T10:30:00Z",
    "createdAt": "2024-01-15T10:30:00Z"
  }
}
```

### Submitting Evidence

```bash
curl -X POST "http://localhost:3001/v1/transactions/{transaction_id}/dispute/evidence" \
  -H "Authorization: Bearer {jwt_token}" \
  -H "Content-Type: application/json" \
  -d '{
    "evidence": {
      "customCaseUrl": "https://example.com/case/123",
      "customerCommunication": "Email from customer confirming order",
      "customerName": "John Doe",
      "customerEmailAddress": "customer@example.com",
      "productDescription": "Digital product delivery",
      "refundPolicy": "No refund policy for digital products"
    }
  }'
```

## Reconciliation

### Automatic Reconciliation

ScriptPay automatically reconciles transactions with Stripe to detect discrepancies.

**Reconciliation Status**:

```bash
curl "http://localhost:3001/v1/transactions/reconciliation/status" \
  -H "Authorization: Bearer {jwt_token}"
```

**Response**:

```json
{
  "success": true,
  "data": {
    "lastReconciliation": "2024-01-15T10:30:00Z",
    "nextReconciliation": "2024-01-16T10:30:00Z",
    "recordCount": 542,
    "discrepancies": 0,
    "status": "in_sync"
  }
}
```

### Manual Reconciliation

If discrepancies detected:

```bash
curl -X POST "http://localhost:3001/v1/transactions/reconciliation/manual" \
  -H "Authorization: Bearer {jwt_token}" \
  -d '{
    "startDate": "2024-01-01",
    "endDate": "2024-01-31"
  }'
```

## Transaction Webhooks

Merchants receive real-time webhook notifications for transaction events.

**Events**:

- `transaction.created` - New transaction created
- `transaction.processing` - Payment being processed
- `transaction.succeeded` - Payment successful
- `transaction.failed` - Payment failed
- `transaction.refunded` - Refund processed
- `transaction.disputed` - Chargeback filed

See [Webhooks](./webhooks.md) for configuration and verification.

## Performance Tips

### Pagination

Always use pagination for large queries:

```bash
# ✅ Good
curl "http://localhost:3001/v1/transactions?limit=50&offset=0"

# ❌ Avoid
curl "http://localhost:3001/v1/transactions?limit=10000"
```

### Filtering

Narrow queries with filters:

```bash
# ✅ Good - filters by date and status
curl "http://localhost:3001/v1/transactions?status=succeeded&startDate=2024-01-01"

# ❌ Slow - no filters
curl "http://localhost:3001/v1/transactions"
```

### Caching

The dashboard caches transaction data:

- Summary data: 5-minute cache
- Individual transaction: 1-hour cache
- List of transactions: 2-minute cache

## Data Retention

- **Live transactions**: Indefinite
- **Refunded transactions**: Retained indefinitely
- **Failed transactions**: Retained for compliance
- **Disputed transactions**: Retained until dispute resolved + 1 year

## API Limits

- **Query limit**: 100 transactions per request (max)
- **Date range**: 90-day maximum (per query)
- **Export limit**: 100k transactions per export
- **Search**: Indexed fields only (email, ID, status)

## Troubleshooting

### "Transaction not found"

- Verify transaction ID is correct
- Transaction may belong to different merchant
- Recently created transactions may take a few seconds to index

### "Too many results"

- Reduce date range
- Add more specific filters
- Use pagination (limit + offset)

### Export taking too long

- Reduce date range
- Use CSV format (smaller file size)
- Try again in off-peak hours
