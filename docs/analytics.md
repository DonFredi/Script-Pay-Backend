# Analytics & Reporting

## Overview

ScriptPay provides real-time analytics and detailed reporting on payment activity, customer behavior, and business metrics.

## Dashboard Metrics

### Overview Widget

```bash
curl "http://localhost:3001/v1/analytics/overview?days=30" \
  -H "Authorization: Bearer {jwt_token}"
```

**Response**:

```json
{
  "success": true,
  "data": {
    "period": {
      "startDate": "2024-01-15",
      "endDate": "2024-02-14",
      "days": 30
    },
    "metrics": {
      "totalVolume": {
        "amount": 150000000, // cents
        "currency": "USD",
        "transactionCount": 4521,
        "change": 15.5, // % change from previous period
        "trend": "up"
      },
      "averageTransaction": {
        "amount": 33200,
        "change": -2.3,
        "trend": "down"
      },
      "successRate": {
        "percentage": 98.2,
        "change": 0.5,
        "trend": "up"
      },
      "topPaymentMethod": {
        "type": "card",
        "brand": "visa",
        "percentage": 65.3
      }
    }
  }
}
```

## Revenue Analytics

### Revenue Over Time

```bash
curl "http://localhost:3001/v1/analytics/revenue?groupBy=day&startDate=2024-01-01&endDate=2024-02-14" \
  -H "Authorization: Bearer {jwt_token}"
```

**Response**:

```json
{
  "success": true,
  "data": {
    "series": [
      {
        "date": "2024-01-15",
        "revenue": 5000000, // cents
        "transactionCount": 152,
        "averageAmount": 32895,
        "successRate": 98.0
      },
      {
        "date": "2024-01-16",
        "revenue": 4800000,
        "transactionCount": 145,
        "averageAmount": 33103,
        "successRate": 99.3
      }
    ],
    "summary": {
      "totalRevenue": 150000000,
      "totalTransactions": 4521,
      "averageDaily": 5000000,
      "maxDaily": 6500000,
      "minDaily": 3200000
    }
  }
}
```

**Grouping Options**:

- `hour` - Hourly breakdown
- `day` - Daily breakdown (default)
- `week` - Weekly breakdown
- `month` - Monthly breakdown

## Customer Analytics

### Customer Metrics

```bash
curl "http://localhost:3001/v1/analytics/customers?startDate=2024-01-01" \
  -H "Authorization: Bearer {jwt_token}"
```

**Response**:

```json
{
  "success": true,
  "data": {
    "totalCustomers": 2341,
    "newCustomers": 156, // This period
    "returningCustomers": 2185,
    "repeatPurchaseRate": 93.3, // % of returning
    "averageCustomerValue": 63995, // lifetime value in cents
    "churnRate": 2.1 // % lost to churn
  }
}
```

### Customer Cohorts

```bash
curl "http://localhost:3001/v1/analytics/cohorts?cohortBy=signupDate" \
  -H "Authorization: Bearer {jwt_token}"
```

## Payment Method Analytics

### Payment Method Breakdown

```bash
curl "http://localhost:3001/v1/analytics/payment-methods" \
  -H "Authorization: Bearer {jwt_token}"
```

**Response**:

```json
{
  "success": true,
  "data": {
    "byType": [
      {
        "type": "card",
        "volume": 120000000,
        "count": 3600,
        "percentage": 80.0,
        "successRate": 98.5,
        "brands": {
          "visa": { "volume": 78000000, "count": 2340, "percentage": 52.0 },
          "mastercard": { "volume": 36000000, "count": 1080, "percentage": 24.0 },
          "amex": { "volume": 6000000, "count": 180, "percentage": 4.0 }
        }
      },
      {
        "type": "wallet",
        "volume": 30000000,
        "count": 921,
        "percentage": 20.0,
        "successRate": 99.2
      }
    ]
  }
}
```

## Failure Analytics

### Failure Reasons

```bash
curl "http://localhost:3001/v1/analytics/failures?startDate=2024-01-01" \
  -H "Authorization: Bearer {jwt_token}"
```

**Response**:

```json
{
  "success": true,
  "data": {
    "totalFailures": 79,
    "failureRate": 1.7, // percent
    "byReason": [
      {
        "reason": "card_declined",
        "code": "declined",
        "count": 35,
        "percentage": 44.3,
        "trend": "stable"
      },
      {
        "reason": "expired_card",
        "code": "expired_card",
        "count": 18,
        "percentage": 22.8,
        "trend": "up"
      },
      {
        "reason": "insufficient_funds",
        "code": "insufficient_funds",
        "count": 12,
        "percentage": 15.2,
        "trend": "down"
      }
    ]
  }
}
```

## Geographic Analytics

### Volume by Country

```bash
curl "http://localhost:3001/v1/analytics/geography" \
  -H "Authorization: Bearer {jwt_token}"
```

**Response**:

```json
{
  "success": true,
  "data": {
    "byCountry": [
      {
        "country": "United States",
        "countryCode": "US",
        "volume": 95000000,
        "transactionCount": 3000,
        "percentage": 63.3,
        "successRate": 98.8
      },
      {
        "country": "United Kingdom",
        "countryCode": "GB",
        "volume": 31500000,
        "transactionCount": 1050,
        "percentage": 21.0,
        "successRate": 97.5
      },
      {
        "country": "Canada",
        "countryCode": "CA",
        "volume": 23500000,
        "transactionCount": 471,
        "percentage": 15.7,
        "successRate": 98.1
      }
    ]
  }
}
```

## Recurring Revenue (Planned Q2)

### Subscription Metrics

```bash
curl "http://localhost:3001/v1/analytics/subscriptions" \
  -H "Authorization: Bearer {jwt_token}"
```

## Custom Reports

### Report Builder

```bash
curl -X POST "http://localhost:3001/v1/analytics/reports/custom" \
  -H "Authorization: Bearer {jwt_token}" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Q1 Revenue Report",
    "description": "Revenue by payment method for Q1",
    "metrics": [
      "totalVolume",
      "transactionCount",
      "successRate"
    ],
    "dimensions": [
      "paymentMethod",
      "date"
    ],
    "filters": {
      "startDate": "2024-01-01",
      "endDate": "2024-03-31",
      "status": "succeeded"
    },
    "schedule": "monthly",
    "recipients": ["finance@example.com"]
  }'
```

## Export Analytics

### Export Report Data

```bash
curl "http://localhost:3001/v1/analytics/export?report=revenue&format=csv&startDate=2024-01-01" \
  -H "Authorization: Bearer {jwt_token}" \
  > analytics.csv
```

**Supported Formats**:

- CSV
- JSON
- PDF (formatted report)
- Excel (.xlsx)

## Real-time Webhooks

Receive analytics updates via webhooks.

**Analytics Events**:

- `analytics.daily_summary` - Daily metrics compiled
- `analytics.volume_alert` - Unusual volume detected
- `analytics.failure_rate_alert` - High failure rate
- `analytics.revenue_milestone` - Revenue milestone reached

**Example webhook**:

```json
{
  "event": "analytics.daily_summary",
  "data": {
    "date": "2024-01-15",
    "totalVolume": 5000000,
    "transactionCount": 152,
    "successRate": 98.2,
    "averageAmount": 32894
  },
  "timestamp": "2024-01-16T01:00:00Z"
}
```

## Alerts & Notifications

### Alert Configuration

```bash
curl -X POST "http://localhost:3001/v1/analytics/alerts" \
  -H "Authorization: Bearer {jwt_token}" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "High Failure Rate Alert",
    "condition": "failureRate > 5",
    "timeWindow": 3600,
    "alertChannels": ["email", "webhook"],
    "recipients": ["admin@example.com"]
  }'
```

### Alert Types

```typescript
enum AlertType {
  // Volume Alerts
  UNUSUAL_VOLUME = "unusual_volume",
  VOLUME_SPIKE = "volume_spike",
  VOLUME_DROP = "volume_drop",

  // Performance Alerts
  HIGH_FAILURE_RATE = "high_failure_rate",
  SLOW_TRANSACTIONS = "slow_transactions",

  // Financial Alerts
  REVENUE_MILESTONE = "revenue_milestone",
  REFUND_SPIKE = "refund_spike",

  // Security Alerts
  FRAUD_DETECTED = "fraud_detected",
  UNUSUAL_LOCATION = "unusual_location",
}
```

## Dashboard Widgets

### Available Widgets

| Widget              | Description           | Update Frequency |
| ------------------- | --------------------- | ---------------- |
| Revenue Card        | Total volume overview | Real-time        |
| Transaction Chart   | Volume over time      | 1 minute         |
| Payment Methods     | Breakdown by type     | 5 minutes        |
| Recent Transactions | Latest activity       | Real-time        |
| Success Rate        | Transaction success % | 1 minute         |
| Top Customers       | Highest spenders      | 1 hour           |
| Geographic Map      | Volume by location    | 1 hour           |
| Failure Reasons     | Why transactions fail | 5 minutes        |

### Widget Customization

```bash
curl -X PUT "http://localhost:3001/v1/dashboard/widgets/{widget_id}" \
  -H "Authorization: Bearer {jwt_token}" \
  -d '{
    "position": 1,
    "size": "medium",
    "autoRefresh": true,
    "refreshInterval": 60
  }'
```

## Performance Considerations

### Data Freshness

- **Real-time metrics**: 5-second delay
- **Dashboard summary**: 1-minute delay
- **Detailed analytics**: 5-minute delay
- **Custom reports**: Generated on-demand (up to 5 minutes)

### Query Limits

- **Date range**: Up to 2 years
- **Rows returned**: Up to 100,000 per query
- **Concurrent queries**: 5 per API key
- **Export size**: Max 100MB per file

## API Rate Limiting

Analytics endpoints have separate rate limits:

- General analytics: 1000 requests/hour
- Real-time data: 100 requests/minute
- Report generation: 10 concurrent reports

## Best Practices

1. **Cache dashboard data** - Reduce API calls
2. **Use appropriate time ranges** - Don't query entire history
3. **Set up alerts** - Get notified of anomalies
4. **Schedule reports** - Automate reporting
5. **Monitor key metrics** - Focus on business KPIs

## Troubleshooting

### "No data available"

- Verify date range has transactions
- Check merchant has permission to view analytics
- May take 5 minutes for data to appear

### "Query timeout"

- Reduce date range
- Add more specific filters
- Try again in off-peak hours

### "Export failed"

- Reduce export size
- Try different format
- Contact support if persists
