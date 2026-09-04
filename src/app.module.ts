import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { ScheduleModule } from "@nestjs/schedule";
import { ThrottlerModule } from "@nestjs/throttler";
import { APP_FILTER, APP_INTERCEPTOR } from "@nestjs/core";
import { PrismaModule } from "./modules/prisma/prisma.module";
import { AlertsModule } from "./modules/alerts/alerts.module";
import { AuditLogModule } from "./modules/audit-log/audit-log.module";
import { AuthModule } from "./modules/auth/auth.module";
import { TenantsModule } from "./modules/tenants/tenants.module";
import { ApiKeysModule } from "./modules/api-keys/api-keys.module";
import { LedgerModule } from "./modules/ledger/ledger.module";
import { PaymentsModule } from "./modules/payments/payments.module";
import { CallbacksModule } from "./modules/callbacks/callbacks.module";
import { ReconciliationModule } from "./modules/reconciliation/reconciliation.module";
import { ReportingModule } from "./modules/reporting/reporting.module";
import { HealthModule } from "./modules/health/health.module";
import { JobsModule } from "./modules/jobs/jobs.module";
import { HttpExceptionFilter } from "./common/filters/http-exception.filter";
import { LoggingInterceptor } from "./common/interceptors/logging.interceptor";
import { ResponseTransformInterceptor } from "./common/interceptors/response-transform.interceptor";

/**
 * Each feature module owns its own controllers/services/DTOs and only exports what
 * other modules genuinely need (e.g. PaymentsModule exports TransactionStateMachine
 * for CallbacksModule to apply webhook results to). This is the actual clean-architecture
 * boundary — AppModule wires modules together, it does not contain business logic itself.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 60 }]), // fallback default; controllers override via @Throttle()
    PrismaModule,
    AlertsModule,
    AuditLogModule,
    AuthModule,
    TenantsModule,
    ApiKeysModule,
    LedgerModule,
    PaymentsModule,
    CallbacksModule,
    ReconciliationModule,
    ReportingModule,
    HealthModule,
    JobsModule,
  ],
  providers: [
    // RolesGuard is intentionally NOT global here. It depends on request.user, which
    // is only populated by AccessTokenGuard — and NestJS runs global (APP_GUARD)
    // guards BEFORE controller-level @UseGuards() guards. A global RolesGuard would
    // therefore always see an empty request.user and reject every @Roles()-protected
    // route regardless of actual role. RolesGuard is instead applied explicitly,
    // per-controller, AFTER AccessTokenGuard in each @UseGuards([...]) array.
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
    { provide: APP_INTERCEPTOR, useClass: LoggingInterceptor },
    { provide: APP_INTERCEPTOR, useClass: ResponseTransformInterceptor },
  ],
})
export class AppModule {}
