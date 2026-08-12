# Webhooks & Integrations

## Overview

Webhooks allow ScriptPay to send real-time notifications to your application when events occur (payments, refunds, disputes, etc.).

## Getting Started

### Register a Webhook Endpoint

```bash
curl -X POST "http://localhost:3001/v1/webhooks/endpoints" \
  -H "Authorization: Bearer {jwt_token}" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://example.com/webhooks/scriptpay",
    "events": ["transaction.succeeded", "transaction.failed", "payment.refunded"],
    "active": true,
    "description": "Main webhook for payment events"
  }'
```

**Response**:

```json
{
  "success": true,
  "data": {
    "id": "wh_endpoint_123",
    "url": "https://example.com/webhooks/scriptpay",
    "status": "active",
    "secret": "whsec_test_1234567890",
    "createdAt": "2024-01-15T10:30:00Z"
  }
}
```

**Important**: Save the webhook secret securely. You'll need it to verify webhook signatures.

### List Webhook Endpoints

```bash
curl "http://localhost:3001/v1/webhooks/endpoints" \
  -H "Authorization: Bearer {jwt_token}"
```

### Update Webhook Endpoint

```bash
curl -X PUT "http://localhost:3001/v1/webhooks/endpoints/{endpoint_id}" \
  -H "Authorization: Bearer {jwt_token}" \
  -H "Content-Type: application/json" \
  -d '{
    "events": ["transaction.succeeded", "transaction.failed"],
    "active": true
  }'
```

## Webhook Events

### Payment Events

#### transaction.created

Triggered when a new transaction is created.

```json
{
  "event": "transaction.created",
  "id": "evt_1234567890",
  "data": {
    "id": "txn_abc123",
    "merchantId": "merchant_xyz",
    "status": "pending",
    "amount": 2999,
    "currency": "USD",
    "customerEmail": "customer@example.com",
    "customerName": "John Doe",
    "createdAt": "2024-01-15T10:30:00Z"
  },
  "timestamp": "2024-01-15T10:30:00Z",
  "version": "2024-01-01"
}
```

#### transaction.succeeded

Triggered when payment successfully processes.

```json
{
  "event": "transaction.succeeded",
  "id": "evt_2234567890",
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

#### transaction.failed

Triggered when payment is declined or fails.

```json
{
  "event": "transaction.failed",
  "id": "evt_3234567890",
  "data": {
    "id": "txn_abc123",
    "status": "failed",
    "amount": 2999,
    "currency": "USD",
    "failureReason": "Card declined",
    "failureCode": "card_declined"
  },
  "timestamp": "2024-01-15T10:35:00Z"
}
```

### Refund Events

#### payment.refunded

Triggered when refund is processed.

```json
{
  "event": "payment.refunded",
  "id": "evt_4234567890",
  "data": {
    "transactionId": "txn_abc123",
    "refundId": "ref_xyz789",
    "amount": 2999,
    "reason": "customer_request",
    "status": "succeeded"
  },
  "timestamp": "2024-01-15T10:40:00Z"
}
```

### Invoice Events

#### invoice.created

```json
{
  "event": "invoice.created",
  "data": {
    "id": "inv_123",
    "merchantId": "merchant_xyz",
    "amount": 50000,
    "status": "draft",
    "createdAt": "2024-01-15T10:30:00Z"
  }
}
```

#### invoice.sent

```json
{
  "event": "invoice.sent",
  "data": {
    "id": "inv_123",
    "status": "sent",
    "sentAt": "2024-01-15T10:31:00Z"
  }
}
```

#### invoice.paid

```json
{
  "event": "invoice.paid",
  "data": {
    "id": "inv_123",
    "status": "paid",
    "paidAt": "2024-01-16T14:20:00Z"
  }
}
```

### Dispute Events

#### transaction.disputed

```json
{
  "event": "transaction.disputed",
  "data": {
    "transactionId": "txn_abc123",
    "disputeId": "disp_123",
    "reason": "fraudulent",
    "status": "evidence_required",
    "deadline": "2024-01-22T10:30:00Z"
  }
}
```

## Receiving Webhooks

### Webhook Payload Format

Every webhook includes:

- `event` - Event type
- `id` - Unique event ID (for deduplication)
- `data` - Event-specific data
- `timestamp` - ISO 8601 timestamp
- `version` - API version

### Handling Webhooks

```javascript
// Express.js example
app.post("/webhooks/scriptpay", express.json(), (req, res) => {
  const event = req.body;

  // Verify webhook signature
  if (!verifyWebhookSignature(req.body, req.headers["x-webhook-signature"])) {
    return res.status(401).json({ error: "Invalid signature" });
  }

  // Idempotency: check if event already processed
  if (eventAlreadyProcessed(event.id)) {
    return res.status(200).json({ success: true });
  }

  // Handle event
  switch (event.event) {
    case "transaction.succeeded":
      handleTransactionSuccess(event.data);
      break;
    case "transaction.failed":
      handleTransactionFailure(event.data);
      break;
    case "payment.refunded":
      handleRefund(event.data);
      break;
    // ... handle other events
  }

  // Mark event as processed
  markEventProcessed(event.id);

  // Acknowledge receipt
  res.status(200).json({ success: true });
});
```

## Security: Verifying Webhook Signatures

### Signature Verification

All webhooks include an `X-Webhook-Signature` header. Always verify this signature.

**Header Format**:

```
X-Webhook-Signature: t=1705328400,v1=abcdef123456789...
```

**Verification Steps**:

1. Extract timestamp and signature
2. Recreate signed content: `{timestamp}.{payload}`
3. Hash with webhook secret
4. Compare with provided signature

### Implementation Examples

**JavaScript/Node.js**:

```javascript
const crypto = require("crypto");

function verifyWebhookSignature(payload, signature, secret) {
  // Parse signature header
  const parts = signature.split(",");
  const timestamp = parts[0].split("=")[1];
  const providedSignature = parts[1].split("=")[1];

  // Recreate signed content
  const signedContent = `${timestamp}.${JSON.stringify(payload)}`;

  // Calculate expected signature
  const expectedSignature = crypto.createHmac("sha256", secret).update(signedContent).digest("hex");

  // Constant-time comparison to prevent timing attacks
  return crypto.timingSafeEqual(Buffer.from(providedSignature), Buffer.from(expectedSignature));
}

// Usage
const signature = req.headers["x-webhook-signature"];
const isValid = verifyWebhookSignature(req.body, signature, WEBHOOK_SECRET);
```

**Python**:

```python
import hmac
import hashlib
import time
from flask import Flask, request, jsonify

def verify_webhook_signature(payload, signature, secret):
    # Parse signature header
    parts = dict(item.split('=') for item in signature.split(','))
    timestamp = int(parts['t'])
    provided_signature = parts['v1']

    # Verify timestamp (within 5 minutes)
    if abs(time.time() - timestamp) > 300:
        return False

    # Recreate signed content
    signed_content = f"{timestamp}.{payload}"

    # Calculate expected signature
    expected_signature = hmac.new(
        secret.encode(),
        signed_content.encode(),
        hashlib.sha256
    ).hexdigest()

    # Constant-time comparison
    return hmac.compare_digest(provided_signature, expected_signature)
```

**Go**:

```go
package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"fmt"
	"strings"
)

func verifyWebhookSignature(payload, signature, secret string) bool {
	parts := strings.Split(signature, ",")

	timestamp := strings.Split(parts[0], "=")[1]
	providedSig := strings.Split(parts[1], "=")[1]

	signedContent := fmt.Sprintf("%s.%s", timestamp, payload)

	h := hmac.New(sha256.New, []byte(secret))
	h.Write([]byte(signedContent))
	expectedSig := fmt.Sprintf("%x", h.Sum(nil))

	return hmac.Equal([]byte(providedSig), []byte(expectedSig))
}
```

## Retry Logic

ScriptPay automatically retries failed webhook deliveries.

### Retry Schedule

```
1st attempt: Immediate
2nd attempt: 5 seconds later
3rd attempt: 30 seconds later
4th attempt: 2 minutes later
5th attempt: 5 minutes later
```

**Total**: Up to 5 attempts over ~8 minutes

### Webhook Timeout

- **Timeout**: 30 seconds per request
- **Max payload size**: 1MB
- **Expected response**: HTTP 2xx status code

## Webhook Management

### List Webhook Events

```bash
curl "http://localhost:3001/v1/webhooks/events?limit=50&status=pending" \
  -H "Authorization: Bearer {jwt_token}"
```

### Resend a Webhook

```bash
curl -X POST "http://localhost:3001/v1/webhooks/events/{event_id}/resend" \
  -H "Authorization: Bearer {jwt_token}"
```

### Get Webhook Event Details

```bash
curl "http://localhost:3001/v1/webhooks/events/{event_id}" \
  -H "Authorization: Bearer {jwt_token}"
```

## Best Practices

### 1. Verify Signatures

Always verify webhook signatures before processing.

### 2. Idempotency

Track event IDs to handle retries gracefully.

```javascript
// Store processed event IDs in database/cache
async function processWebhook(event) {
  const { id, data } = event;

  // Check if already processed
  const existing = await db.events.findOne({ eventId: id });
  if (existing) {
    return { success: true, duplicate: true };
  }

  // Process event
  await handleEvent(data);

  // Mark as processed
  await db.events.create({ eventId: id, processedAt: new Date() });
}
```

### 3. Acknowledge Quickly

Return HTTP 200 immediately, do async processing.

```javascript
app.post("/webhooks/scriptpay", async (req, res) => {
  const event = req.body;

  // Verify signature
  if (!verifySignature(req.body, req.headers["x-webhook-signature"])) {
    return res.status(401).json({ error: "Invalid" });
  }

  // Acknowledge immediately
  res.status(200).json({ success: true });

  // Process asynchronously
  processWebhookAsync(event).catch(console.error);
});
```

### 4. Log Webhooks

Log all webhook activity for debugging.

```javascript
async function logWebhook(event, status, error) {
  await db.webhookLogs.create({
    eventId: event.id,
    eventType: event.event,
    status,
    error,
    receivedAt: new Date(),
  });
}
```

### 5. Monitor Delivery

Track webhook delivery status and failures.

```bash
curl "http://localhost:3001/v1/webhooks/stats?startDate=2024-01-01" \
  -H "Authorization: Bearer {jwt_token}"
```

## Troubleshooting

### Webhooks Not Received

1. Check endpoint is reachable
2. Verify endpoint is active
3. Check webhook logs in dashboard
4. Ensure endpoint returns 2xx status

### Invalid Signature

1. Verify webhook secret matches
2. Check payload isn't modified
3. Ensure timestamp validation logic correct

### Events Not Processing

1. Verify event ID handling (idempotency)
2. Check error handling in endpoint
3. Review webhook logs
4. Test with manual resend

## Webhook Testing

### Test Webhook Delivery

```bash
curl -X POST "http://localhost:3001/v1/webhooks/endpoints/{id}/test" \
  -H "Authorization: Bearer {jwt_token}"
```

Sends test event to verify endpoint is reachable and responding correctly.

## Rate Limits

- **Webhook delivery**: Unlimited (per merchant)
- **Event history**: Last 90 days
- **Retry limit**: 5 attempts per event
- **Concurrent deliveries**: 100 per merchant

## Archive & Retention

- Webhook events retained for 90 days
- Successful deliveries archived after 30 days
- Failed events retained for full 90 days for troubleshooting
