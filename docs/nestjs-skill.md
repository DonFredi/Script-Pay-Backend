# NestJS Skill Guide

## Overview

Best practices and patterns for NestJS development on ScriptPay.

## Module Organization

### Recommended Structure

```typescript
// auth.module.ts
import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { PassportModule } from "@nestjs/passport";

import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { JwtStrategy } from "./jwt.strategy";

@Module({
  imports: [
    PassportModule,
    JwtModule.register({
      secret: process.env.JWT_SECRET,
      signOptions: { expiresIn: "15m" },
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy],
  exports: [AuthService], // Export if used by other modules
})
export class AuthModule {}
```

### Key Patterns

1. **Controllers**: HTTP request handling only
2. **Services**: Business logic and database access
3. **Guards**: Authentication and authorization
4. **Interceptors**: Logging, transformation, error handling
5. **Pipes**: Validation and transformation
6. **Decorators**: Custom metadata

## Service Patterns

### Dependency Injection

```typescript
import { Injectable } from "@nestjs/common";
import { PrismaService } from "../database/prisma.service";
import { LoggerService } from "../common/logger.service";

@Injectable()
export class TransactionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly logger: LoggerService,
    private readonly stripe: StripeService,
  ) {}

  async create(dto: CreateTransactionDto): Promise<Transaction> {
    // Implementation
  }
}
```

### Error Handling

```typescript
import { HttpException, HttpStatus, BadRequestException } from "@nestjs/common";

export class PaymentException extends HttpException {
  constructor(message: string, code: string = "PAYMENT_ERROR") {
    super(
      {
        success: false,
        error: {
          code,
          message,
        },
      },
      HttpStatus.BAD_REQUEST,
    );
  }
}

// Usage
if (!isValidAmount(amount)) {
  throw new BadRequestException("Amount must be greater than 0");
}

if (paymentFailed) {
  throw new PaymentException("Payment processing failed", "PAYMENT_FAILED");
}
```

### Database Operations

```typescript
// Always use Prisma for database operations
async findTransaction(id: string): Promise<Transaction> {
  const transaction = await this.prisma.transaction.findUnique({
    where: { id },
    include: {
      // Load relationships
      merchant: true,
      refunds: true,
    },
  });

  if (!transaction) {
    throw new NotFoundException(`Transaction ${id} not found`);
  }

  return transaction;
}

// Use transactions for consistency
async processRefund(transactionId: string, amount: number) {
  return await this.prisma.$transaction(async (tx) => {
    // Fetch transaction
    const transaction = await tx.transaction.findUnique({
      where: { id: transactionId },
    });

    // Create refund
    await tx.refund.create({
      data: {
        transactionId,
        amount,
        status: 'pending',
      },
    });

    // Update transaction
    await tx.transaction.update({
      where: { id: transactionId },
      data: { status: 'refunding' },
    });
  });
}
```

## Controller Patterns

### Request/Response

```typescript
import { Controller, Get, Post, Body, Param, Query } from "@nestjs/common";

@Controller("transactions")
export class TransactionsController {
  constructor(private readonly service: TransactionsService) {}

  @Get()
  async list(
    @Query("limit") limit: number = 20,
    @Query("offset") offset: number = 0,
    @Query("status") status?: string,
  ) {
    const transactions = await this.service.list({
      limit: Math.min(limit, 100), // Max 100
      offset,
      status,
    });

    return {
      success: true,
      data: transactions,
      meta: {
        limit,
        offset,
        hasMore: transactions.length === limit,
      },
    };
  }

  @Post()
  async create(@Body() dto: CreateTransactionDto) {
    const transaction = await this.service.create(dto);
    return {
      success: true,
      data: transaction,
    };
  }

  @Get(":id")
  async findOne(@Param("id") id: string) {
    const transaction = await this.service.findOne(id);
    return {
      success: true,
      data: transaction,
    };
  }
}
```

## Guard & Decorator Patterns

### Custom Auth Decorator

```typescript
// common/decorators/auth.decorator.ts
import { SetMetadata, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../guards/jwt-auth.guard";

export const Auth = () => {
  return UseGuards(JwtAuthGuard);
};

// Usage
@Controller("transactions")
export class TransactionsController {
  @Get()
  @Auth()
  async list() {
    // Protected endpoint
  }
}
```

### Custom Permission Decorator

```typescript
// common/decorators/permission.decorator.ts
import { SetMetadata } from "@nestjs/common";

export const Permission = (...permissions: string[]) => SetMetadata("permissions", permissions);

// common/guards/permission.guard.ts
import { Injectable, CanActivate, ExecutionContext } from "@nestjs/common";
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

    return permissions.some((permission) => user.permissions.includes(permission));
  }
}

// Usage
@Controller("transactions")
export class TransactionsController {
  @Delete(":id")
  @Permission("delete:transactions")
  async delete(@Param("id") id: string) {
    // Only accessible to users with delete:transactions permission
  }
}
```

## Interceptor Patterns

### Logging Interceptor

```typescript
import { Injectable, NestInterceptor, ExecutionContext, CallHandler } from "@nestjs/common";
import { Observable } from "rxjs";
import { tap } from "rxjs/operators";

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const request = context.switchToHttp().getRequest();
    const { method, url } = request;
    const start = Date.now();

    return next.handle().pipe(
      tap(() => {
        const duration = Date.now() - start;
        console.log(`${method} ${url} - ${duration}ms`);
      }),
    );
  }
}
```

### Error Handling Interceptor

```typescript
import { Injectable, NestInterceptor, ExecutionContext, CallHandler } from "@nestjs/common";
import { Observable, throwError } from "rxjs";
import { catchError } from "rxjs/operators";

@Injectable()
export class ErrorInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    return next.handle().pipe(
      catchError((error) => {
        // Log error
        console.error("Error:", error.message);

        // Transform error to consistent format
        return throwError(
          () =>
            new HttpException(
              {
                success: false,
                error: {
                  code: error.code || "INTERNAL_ERROR",
                  message: error.message,
                },
              },
              error.status || HttpStatus.INTERNAL_SERVER_ERROR,
            ),
        );
      }),
    );
  }
}
```

## Validation & Pipes

### DTO with Validation

```typescript
import { IsEmail, IsString, IsNumber, Min, Max } from "class-validator";

export class CreateTransactionDto {
  @IsNumber()
  @Min(50) // Minimum 50 cents
  @Max(9999999) // Maximum $99,999.99
  amount: number;

  @IsString()
  currency: string;

  @IsEmail()
  customerEmail: string;

  @IsString()
  description?: string;
}
```

### Global Validation Pipe

```typescript
// main.ts
import { ValidationPipe } from "@nestjs/common";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Global validation
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true, // Strip unknown properties
      forbidNonWhitelisted: true, // Reject unknown properties
      transform: true, // Transform DTOs
    }),
  );

  await app.listen(3001);
}

bootstrap();
```

## Testing

### Unit Test Example

```typescript
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
          useValue: {
            transaction: {
              create: jest.fn(),
              findUnique: jest.fn(),
              findMany: jest.fn(),
            },
          },
        },
      ],
    }).compile();

    service = module.get<TransactionsService>(TransactionsService);
    prisma = module.get<PrismaService>(PrismaService);
  });

  describe("create", () => {
    it("should create a transaction", async () => {
      const dto: CreateTransactionDto = {
        amount: 2999,
        currency: "USD",
        customerEmail: "test@example.com",
      };

      const expected = { id: "txn_123", ...dto };

      jest.spyOn(prisma.transaction, "create").mockResolvedValue(expected);

      const result = await service.create(dto);

      expect(result).toEqual(expected);
      expect(prisma.transaction.create).toHaveBeenCalledWith({
        data: dto,
      });
    });
  });
});
```

## Common Anti-Patterns to Avoid

❌ **Don't**: Put business logic in controllers

```typescript
// BAD
@Post('transactions')
async create(@Body() dto: CreateTransactionDto) {
  // Business logic here - WRONG!
  const amount = Math.round(dto.amount * 100);
  // ...
}
```

✅ **Do**: Move logic to services

```typescript
// GOOD
@Post('transactions')
async create(@Body() dto: CreateTransactionDto) {
  return this.transactionsService.create(dto);
}
```

❌ **Don't**: Handle errors inline everywhere

```typescript
// BAD
try {
  // ...
} catch (error) {
  if (error.code === "P2025") {
    throw new NotFoundException("Not found");
  }
  if (error.code === "P2002") {
    throw new ConflictException("Already exists");
  }
  // ... many more catches
}
```

✅ **Do**: Use exception filters

```typescript
// GOOD
@UseFilters(new PrismaExceptionFilter())
async findOne(id: string) {
  return this.prisma.transaction.findUniqueOrThrow({
    where: { id },
  });
}
```

## Performance Tips

1. **Use select/include carefully** - Only fetch needed fields
2. **Add database indexes** - On frequently filtered columns
3. **Implement caching** - For read-heavy endpoints
4. **Use pagination** - Always for list endpoints
5. **Connection pooling** - Configure Prisma pool size

## Security Best Practices

1. **Always validate input** - Use class-validator
2. **Never log sensitive data** - Filter passwords, tokens
3. **Check permissions** - Use guards and decorators
4. **Sanitize errors** - Don't expose system details
5. **Rate limit** - Especially auth endpoints

## Useful Links

- NestJS Docs: https://docs.nestjs.com
- Prisma Docs: https://www.prisma.io/docs
- TypeScript: https://www.typescriptlang.org/docs
