# Deployment

## Environments

### Development

- **URL**: http://localhost:3000 (frontend), http://localhost:3001 (API)
- **Database**: Local PostgreSQL instance
- **Purpose**: Local development and testing
- **Authentication**: Disabled for ease of development

### Staging

- **URL**: https://staging.scriptpay.io
- **Database**: RDS PostgreSQL (separate instance)
- **Purpose**: Pre-production testing, feature preview
- **Deployment**: Push to `staging` branch triggers automatic deployment

### Production

- **URL**: https://scriptpay.io, https://api.scriptpay.io
- **Database**: RDS PostgreSQL (multi-AZ)
- **Purpose**: Live customer environment
- **Deployment**: Tag release with `v*.*.*` triggers automatic deployment

## Local Development Setup

### Prerequisites

```bash
Node.js 18+
Docker & Docker Compose
PostgreSQL 14+
```

### Initial Setup

```bash
# Clone repository
git clone https://github.com/scriptpay/scriptpay.git
cd scriptpay

# Install dependencies
npm install

# Copy environment file
cp .env.example .env.local

# Start PostgreSQL
docker-compose up -d postgres

# Run database migrations
npx prisma migrate dev

# Start development servers
npm run dev
# Frontend: http://localhost:3000
# Backend: http://localhost:3001
```

### Environment Variables (.env.local)

```bash
# Database
DATABASE_URL="postgresql://user:password@localhost:5432/scriptpay"

# API
API_PORT=3001
API_URL="http://localhost:3001/v1"

# Frontend
NEXT_PUBLIC_API_URL="http://localhost:3001/v1"

# JWT
JWT_SECRET="your-super-secret-key-change-in-production"
JWT_EXPIRY="15m"
JWT_REFRESH_EXPIRY="7d"

# Stripe (use test keys)
STRIPE_SECRET_KEY="sk_test_..."
STRIPE_PUBLISHABLE_KEY="pk_test_..."
STRIPE_WEBHOOK_SECRET="whsec_test_..."

# Email
SMTP_HOST="localhost"
SMTP_PORT=1025

# Logging
LOG_LEVEL="debug"
```

### Starting Services

```bash
# Start all services
npm run dev

# Or individually
npm run dev:api      # Terminal 1
npm run dev:dashboard  # Terminal 2
```

## Docker Deployment

### Building Images

```bash
# Build backend image
docker build -f apps/api/Dockerfile -t scriptpay-api:latest .

# Build frontend image
docker build -f apps/dashboard/Dockerfile -t scriptpay-dashboard:latest .
```

### Docker Compose (Staging)

```yaml
# docker-compose.yml
version: "3.8"

services:
  postgres:
    image: postgres:14
    environment:
      POSTGRES_PASSWORD: postgres_password
    ports:
      - "5432:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"

  api:
    build:
      context: .
      dockerfile: apps/api/Dockerfile
    ports:
      - "3001:3001"
    environment:
      DATABASE_URL: postgresql://postgres:postgres_password@postgres:5432/scriptpay
      REDIS_URL: redis://redis:6379
    depends_on:
      - postgres
      - redis

  dashboard:
    build:
      context: .
      dockerfile: apps/dashboard/Dockerfile
    ports:
      - "3000:3000"
    environment:
      NEXT_PUBLIC_API_URL: http://localhost:3001/v1
    depends_on:
      - api

volumes:
  postgres_data:
```

## Kubernetes Deployment (Production)

### Prerequisites

```bash
kubectl config use-context scriptpay-prod
helm repo add scriptpay https://charts.scriptpay.io
```

### Deployment Manifests

```yaml
# k8s/namespace.yaml
apiVersion: v1
kind: Namespace
metadata:
  name: scriptpay
---
# k8s/api-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: scriptpay-api
  namespace: scriptpay
spec:
  replicas: 3
  selector:
    matchLabels:
      app: scriptpay-api
  template:
    metadata:
      labels:
        app: scriptpay-api
    spec:
      containers:
        - name: api
          image: scriptpay/api:v1.0.0
          ports:
            - containerPort: 3001
          env:
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: scriptpay-secrets
                  key: database_url
          resources:
            requests:
              memory: "256Mi"
              cpu: "250m"
            limits:
              memory: "512Mi"
              cpu: "500m"
          livenessProbe:
            httpGet:
              path: /health
              port: 3001
            initialDelaySeconds: 30
            periodSeconds: 10
          readinessProbe:
            httpGet:
              path: /ready
              port: 3001
            initialDelaySeconds: 10
            periodSeconds: 5
---
# k8s/api-service.yaml
apiVersion: v1
kind: Service
metadata:
  name: scriptpay-api
  namespace: scriptpay
spec:
  selector:
    app: scriptpay-api
  ports:
    - protocol: TCP
      port: 80
      targetPort: 3001
  type: LoadBalancer
---
# k8s/ingress.yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: scriptpay-ingress
  namespace: scriptpay
  annotations:
    kubernetes.io/ingress.class: nginx
    cert-manager.io/cluster-issuer: letsencrypt-prod
spec:
  tls:
    - hosts:
        - api.scriptpay.io
      secretName: scriptpay-tls
  rules:
    - host: api.scriptpay.io
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: scriptpay-api
                port:
                  number: 80
```

### Deployment Steps

```bash
# Apply configurations
kubectl apply -f k8s/namespace.yaml
kubectl apply -f k8s/api-deployment.yaml
kubectl apply -f k8s/api-service.yaml
kubectl apply -f k8s/ingress.yaml

# Check deployment status
kubectl rollout status deployment/scriptpay-api -n scriptpay

# View logs
kubectl logs deployment/scriptpay-api -n scriptpay -f
```

## Database Migrations

### Creating Migrations

```bash
# Create a new migration
npx prisma migrate dev --name add_new_feature

# Create without applying (preview)
npx prisma migrate diff --from-url="..." --to-schema-datasource prisma/schema.prisma --script
```

### Applying Migrations

```bash
# Development
npx prisma migrate dev

# Production (CI/CD runs this)
npx prisma migrate deploy
```

### Rollback

```bash
# List migrations
npx prisma migrate resolve --rolled-back migration_name

# Reset database (dev only)
npx prisma migrate reset
```

## CI/CD Pipeline

### GitHub Actions Workflow

```yaml
# .github/workflows/deploy.yml
name: Deploy

on:
  push:
    branches: [main, staging]
    tags: ["v*"]

env:
  REGISTRY: ghcr.io
  IMAGE_NAME: ${{ github.repository }}

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3

      - name: Setup Node
        uses: actions/setup-node@v3
        with:
          node-version: "18"
          cache: "npm"

      - name: Install dependencies
        run: npm ci

      - name: Run lint
        run: npm run lint

      - name: Run tests
        run: npm run test:cov

      - name: Security audit
        run: npm audit --production

  build:
    needs: test
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write

    steps:
      - uses: actions/checkout@v3

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v2

      - name: Log in to Container Registry
        uses: docker/login-action@v2
        with:
          registry: ${{ env.REGISTRY }}
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Build and push API image
        uses: docker/build-push-action@v4
        with:
          context: .
          file: ./apps/api/Dockerfile
          push: true
          tags: ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}-api:${{ github.ref_name }}

  deploy:
    needs: build
    runs-on: ubuntu-latest
    if: github.ref_type == 'tag'

    steps:
      - name: Deploy to Kubernetes
        run: |
          kubectl set image deployment/scriptpay-api \
            scriptpay-api=${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}-api:${{ github.ref_name }} \
            -n scriptpay
          kubectl rollout status deployment/scriptpay-api -n scriptpay
```

## Monitoring & Logging

### Health Checks

```typescript
// Backend health check endpoint
@Get('health')
health() {
  return {
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: process.env.APP_VERSION,
  };
}
```

### Logging

- **Tool**: Winston (NestJS)
- **Levels**: error, warn, info, debug
- **Output**: CloudWatch Logs
- **Retention**: 30 days hot, 1 year cold storage

### Monitoring

- **Tool**: CloudWatch + DataDog
- **Metrics**: Response time, error rate, request volume, database connections
- **Alerts**: Configured for critical thresholds
- **Dashboard**: Real-time monitoring at monitoring.scriptpay.io

### Alerting

```yaml
# AlertManager rules
- alert: HighErrorRate
  expr: rate(http_requests_total{status=~"5.."}[5m]) > 0.05
  for: 5m
  annotations:
    summary: "High error rate detected"

- alert: DatabaseConnPoolExhausted
  expr: pg_stat_activity_count > 48 # max 50 connections
  for: 2m
  annotations:
    summary: "Database connection pool near capacity"
```

## Scaling

### Horizontal Scaling

```bash
# Scale API to 5 replicas
kubectl scale deployment scriptpay-api --replicas=5 -n scriptpay

# Auto-scaling based on CPU
kubectl autoscale deployment scriptpay-api --min=3 --max=10 --cpu-percent=70 -n scriptpay
```

### Vertical Scaling

Adjust resource limits in Kubernetes manifests and redeploy.

## Backup & Recovery

### Backup Strategy

- **Database**: Automated daily snapshots, 30-day retention
- **Configuration**: Stored in Git (encrypted secrets)
- **Application data**: Backed up to S3 with encryption

### Disaster Recovery

1. **Detection**: Monitoring alerts on system failure
2. **Failover**: Automatic DNS failover to standby (if configured)
3. **Recovery**: Restore from latest snapshot
4. **Validation**: Health checks verify system is operational
5. **Communication**: Status page updated

### RTO/RPO

- **RTO** (Recovery Time Objective): 1 hour
- **RPO** (Recovery Point Objective): 15 minutes

## Rollback Procedure

```bash
# If deployment is unstable, rollback to previous version
kubectl rollout undo deployment/scriptpay-api -n scriptpay

# Rollback to specific revision
kubectl rollout history deployment/scriptpay-api -n scriptpay
kubectl rollout undo deployment/scriptpay-api -n scriptpay --to-revision=3

# Verify rollback
kubectl rollout status deployment/scriptpay-api -n scriptpay
```

## Release Checklist

Before tagging a release:

- [ ] All tests pass
- [ ] Code review approved
- [ ] Security audit passed
- [ ] Database migrations tested
- [ ] Performance benchmarks acceptable
- [ ] Release notes prepared
- [ ] Changelog updated
- [ ] Staging deployment verified
- [ ] Rollback plan documented

## Common Issues & Troubleshooting

### Database Connection Refused

```bash
# Check database status
docker ps | grep postgres

# View logs
docker logs postgres

# Reset if needed
docker-compose down -v
docker-compose up -d postgres
```

### High Memory Usage

```bash
# Check resource usage
kubectl top nodes
kubectl top pods -n scriptpay

# If over limit, increase container limits
```

### Slow Deployments

```bash
# Check image size
docker images | grep scriptpay

# Optimize Dockerfile with multi-stage builds
```
