# Coding Standards

## Overview

This guide ensures consistency across the ScriptPay codebase. Adherence to these standards is required for all pull requests.

## Language & Framework Setup

### TypeScript Configuration

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "commonjs",
    "lib": ["ES2020"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "noImplicitAny": true,
    "strictNullChecks": true,
    "strictPropertyInitialization": true
  }
}
```

### Code Formatting

- **Tool**: Prettier
- **Line length**: 100 characters
- **Tabs**: 2 spaces
- **Quotes**: Single quotes (except JSX)
- **Semicolons**: Always
- **Trailing commas**: ES5 (objects/arrays only)

```json
{
  "semi": true,
  "singleQuote": true,
  "printWidth": 100,
  "tabWidth": 2,
  "useTabs": false,
  "trailingComma": "es5",
  "bracketSpacing": true,
  "arrowParens": "always"
}
```

### Linting

- **Tool**: ESLint
- **Config**: Extends `eslint:recommended` + TypeScript plugin
- **Pre-commit**: ESLint runs automatically (husky)

```javascript
// .eslintrc.js
module.exports = {
  parser: "@typescript-eslint/parser",
  extends: ["eslint:recommended", "plugin:@typescript-eslint/recommended", "prettier"],
  rules: {
    "no-console": ["warn", { allow: ["error", "warn"] }],
    "no-unused-vars": "off",
    "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    "@typescript-eslint/explicit-function-return-types": "warn",
  },
};
```

## NestJS Backend Standards

### Project Structure

```
src/
├── common/              # Shared utilities
│   ├── decorators/
│   ├── guards/
│   ├── interceptors/
│   ├── pipes/
│   └── exceptions/
├── auth/                # Auth module
│   ├── auth.controller.ts
│   ├── auth.service.ts
│   ├── auth.module.ts
│   ├── jwt.strategy.ts
│   └── dto/
├── transactions/        # Feature modules (same pattern)
│   ├── transactions.controller.ts
│   ├── transactions.service.ts
│   ├── transactions.module.ts
│   └── dto/
└── app.module.ts       # Root module
```

### Naming Conventions

| Type      | Convention                     | Example                                        |
| --------- | ------------------------------ | ---------------------------------------------- |
| Class     | PascalCase                     | `UserService`, `CreateTransactionDto`          |
| Function  | camelCase                      | `calculateFee()`, `validatePayment()`          |
| Variable  | camelCase                      | `userId`, `transactionAmount`                  |
| Constant  | UPPER_SNAKE_CASE               | `MAX_RETRIES`, `API_TIMEOUT`                   |
| File      | kebab-case                     | `user.service.ts`, `create-transaction.dto.ts` |
| Interface | PascalCase (optional I prefix) | `IPaymentProvider` or `PaymentProvider`        |

### Controllers

```typescript
// transactions.controller.ts
import { Controller, Get, Post, Body, Param } from "@nestjs/common";
import { TransactionsService } from "./transactions.service";
import { CreateTransactionDto } from "./dto/create-transaction.dto";
import { Auth } from "../common/decorators/auth.decorator";

@Controller("transactions")
export class TransactionsController {
  constructor(private readonly transactionsService: TransactionsService) {}

  @Post()
  @Auth() // Custom decorator for JWT auth
  async create(@Body() dto: CreateTransactionDto) {
    return this.transactionsService.create(dto);
  }

  @Get(":id")
  @Auth()
  async findOne(@Param("id") id: string) {
    return this.transactionsService.findOne(id);
  }
}
```

### Services

```typescript
// transactions.service.ts
import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../database/prisma.service";
import { CreateTransactionDto } from "./dto/create-transaction.dto";

@Injectable()
export class TransactionsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateTransactionDto) {
    // Validate input
    // Create record
    // Log action
    // Return response
    return this.prisma.transaction.create({
      data: {
        merchantId: dto.merchantId,
        amount: dto.amount,
        currency: dto.currency,
      },
    });
  }

  async findOne(id: string) {
    const transaction = await this.prisma.transaction.findUnique({
      where: { id },
    });

    if (!transaction) {
      throw new NotFoundException(`Transaction ${id} not found`);
    }

    return transaction;
  }
}
```

### DTOs (Data Transfer Objects)

```typescript
// dto/create-transaction.dto.ts
import { IsString, IsNumber, IsEmail, Min } from "class-validator";

export class CreateTransactionDto {
  @IsNumber()
  @Min(1)
  amount: number;

  @IsString()
  currency: string;

  @IsEmail()
  customerEmail: string;

  @IsString()
  description?: string;
}
```

### Error Handling

```typescript
import { HttpException, HttpStatus } from "@nestjs/common";

// Use built-in exceptions
throw new NotFoundException("Resource not found");
throw new BadRequestException("Invalid input");
throw new UnauthorizedException("Invalid credentials");
throw new ForbiddenException("Access denied");
throw new ConflictException("Resource already exists");

// Custom exception for business logic
export class PaymentException extends HttpException {
  constructor(message: string) {
    super(
      {
        success: false,
        error: {
          code: "PAYMENT_FAILED",
          message,
        },
      },
      HttpStatus.BAD_REQUEST,
    );
  }
}
```

### Dependency Injection

```typescript
// Always use constructor injection
export class TransactionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stripe: StripeService,
    private readonly logger: LoggerService,
  ) {}
}
```

### Module Organization

```typescript
// transactions.module.ts
import { Module } from "@nestjs/common";
import { TransactionsController } from "./transactions.controller";
import { TransactionsService } from "./transactions.service";

@Module({
  imports: [], // Import other modules
  controllers: [TransactionsController],
  providers: [TransactionsService],
  exports: [TransactionsService], // Export if used by other modules
})
export class TransactionsModule {}
```

## Next.js Frontend Standards

### Project Structure

```
apps/dashboard/
├── src/
│   ├── app/                 # App router pages
│   │   ├── page.tsx
│   │   ├── layout.tsx
│   │   └── transactions/
│   ├── components/          # Reusable components
│   │   ├── ui/              # Basic UI components
│   │   ├── forms/
│   │   ├── layout/
│   │   └── features/
│   ├── hooks/               # Custom React hooks
│   ├── lib/                 # Utilities
│   ├── services/            # API client services
│   ├── types/               # TypeScript types
│   └── styles/              # Global styles
├── public/
└── next.config.js
```

### Component Structure

```typescript
// components/features/TransactionCard.tsx
'use client'; // Mark as client component if needed

import React from 'react';
import { Transaction } from '@/types/transaction';
import styles from './TransactionCard.module.css';

interface TransactionCardProps {
  transaction: Transaction;
  onViewDetails?: (id: string) => void;
}

export const TransactionCard: React.FC<TransactionCardProps> = ({
  transaction,
  onViewDetails,
}) => {
  return (
    <div className={styles.card}>
      <h3>{transaction.id}</h3>
      <p>${(transaction.amount / 100).toFixed(2)}</p>
      <button onClick={() => onViewDetails?.(transaction.id)}>
        View Details
      </button>
    </div>
  );
};
```

### Custom Hooks

```typescript
// hooks/useTransactions.ts
import { useState, useCallback } from "react";
import { getTransactions } from "@/services/transactions";
import { Transaction } from "@/types/transaction";

export const useTransactions = () => {
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const fetchTransactions = useCallback(async () => {
    try {
      setLoading(true);
      const data = await getTransactions();
      setTransactions(data);
    } catch (err) {
      setError(err instanceof Error ? err : new Error("Unknown error"));
    } finally {
      setLoading(false);
    }
  }, []);

  return { transactions, loading, error, fetchTransactions };
};
```

### API Client Service

```typescript
// services/transactions.ts
import { Transaction } from "@/types/transaction";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001/v1";

export async function getTransactions(): Promise<Transaction[]> {
  const response = await fetch(`${API_URL}/transactions`, {
    headers: {
      Authorization: `Bearer ${getToken()}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch transactions: ${response.statusText}`);
  }

  const data = await response.json();
  return data.data;
}

function getToken(): string {
  // Retrieve token from cookies or local storage
  return "";
}
```

### Type Safety

```typescript
// types/transaction.ts
export interface Transaction {
  id: string;
  merchantId: string;
  amount: number;
  currency: string;
  status: TransactionStatus;
  customerEmail: string;
  createdAt: string;
}

export type TransactionStatus = "pending" | "succeeded" | "failed" | "refunded";

// types/api.ts
export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
  };
}
```

## Testing Standards

### Unit Tests (NestJS)

```typescript
// transactions.service.spec.ts
import { Test, TestingModule } from "@nestjs/testing";
import { TransactionsService } from "./transactions.service";
import { PrismaService } from "../database/prisma.service";

describe("TransactionsService", () => {
  let service: TransactionsService;
  let prisma: PrismaService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TransactionsService,
        {
          provide: PrismaService,
          useValue: { transaction: { create: jest.fn() } },
        },
      ],
    }).compile();

    service = module.get<TransactionsService>(TransactionsService);
    prisma = module.get<PrismaService>(PrismaService);
  });

  it("should create a transaction", async () => {
    const dto = { amount: 1000, currency: "USD", customerEmail: "test@example.com" };

    jest.spyOn(prisma.transaction, "create").mockResolvedValue({
      id: "123",
      ...dto,
    });

    const result = await service.create(dto);
    expect(result.id).toBe("123");
  });
});
```

### React Component Tests

```typescript
// components/TransactionCard.test.tsx
import { render, screen } from '@testing-library/react';
import { TransactionCard } from './TransactionCard';

describe('TransactionCard', () => {
  it('should render transaction details', () => {
    const transaction = {
      id: '123',
      amount: 2999,
      currency: 'USD',
      status: 'succeeded',
      customerEmail: 'test@example.com',
      createdAt: '2024-01-15T10:00:00Z',
    };

    render(<TransactionCard transaction={transaction} />);
    expect(screen.getByText('123')).toBeInTheDocument();
  });
});
```

### Test Coverage

- **Target**: 80%+ code coverage
- **Tools**: Jest (unit tests), Cypress (E2E tests)
- **Validation**: CI/CD fails if coverage drops

## Documentation Standards

- Every public function needs JSDoc comments
- Complex algorithms need inline comments
- README for each major module
- API endpoints documented in OpenAPI/Swagger

```typescript
/**
 * Creates a new transaction with payment processing
 * @param dto - Transaction creation data
 * @returns Promise<Transaction> - Created transaction object
 * @throws NotFoundException if merchant not found
 * @throws BadRequestException if amount is invalid
 * @example
 * const transaction = await transactionsService.create({
 *   amount: 2999,
 *   currency: 'USD',
 *   customerEmail: 'customer@example.com'
 * });
 */
async create(dto: CreateTransactionDto): Promise<Transaction> {
  // Implementation
}
```

## Git & Version Control

### Branch Naming

```
feature/auth-oauth2
fix/payment-validation
refactor/database-queries
docs/api-reference
chore/update-dependencies
```

### Commit Messages

```
feat: add OAuth2 authentication

- Integrate Google and GitHub providers
- Add multi-factor authentication
- Update user model

Closes #123
```

### Pull Request Template

```
## Description
Brief description of changes

## Type of Change
- [ ] Bug fix
- [ ] New feature
- [ ] Breaking change

## Testing
- [ ] Unit tests added
- [ ] Integration tests added
- [ ] Manual testing done

## Checklist
- [ ] Code follows standards
- [ ] Documentation updated
- [ ] No console logs in production code
- [ ] Secrets not committed
```

## Performance & Optimization

### NestJS

- Use pagination for large datasets
- Implement caching strategies
- Optimize database queries (eager loading)
- Use async/await properly (avoid blocking)
- Monitor endpoint response times

### Next.js

- Use Image component for optimization
- Implement code splitting with dynamic imports
- Lazy load non-critical components
- Minimize bundle size
- Optimize Core Web Vitals

## Security in Code

- Never log sensitive data (passwords, tokens, payment info)
- Validate and sanitize all inputs
- Use prepared statements (Prisma handles this)
- Implement rate limiting on sensitive endpoints
- Use HTTPS only
- Implement CSRF protection
- Set security headers (helmet.js in NestJS)

## Code Review Checklist

Before approving a PR:

- [ ] Code follows naming conventions
- [ ] No console.log() or debugger statements
- [ ] Error handling is appropriate
- [ ] Tests pass and coverage maintained
- [ ] Database queries are optimized
- [ ] Security standards followed
- [ ] Documentation updated
- [ ] No hardcoded secrets

## Tools & Setup

```bash
# Format code
npm run format

# Lint code
npm run lint

# Run tests
npm run test

# Run tests with coverage
npm run test:cov

# Type check
npm run type-check
```

## When to Refactor

- Duplicated code appears 3+ times
- Function has >50 lines
- Cyclomatic complexity >5
- Method has >3 parameters
- Class has >500 lines

## Additional Resources

- [NestJS Best Practices](https://docs.nestjs.com/)
- [Next.js Best Practices](https://nextjs.org/docs)
- [TypeScript Handbook](https://www.typescriptlang.org/docs/)
- [OWASP Secure Coding](https://owasp.org/www-project-secure-coding-practices-quick-reference-guide/)
