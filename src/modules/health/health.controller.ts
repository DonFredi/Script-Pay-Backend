import { Controller, Get, HttpCode, Logger, ServiceUnavailableException } from "@nestjs/common";
import { ThrottlerGuard } from "@nestjs/throttler";
import { UseGuards } from "@nestjs/common";
import { SkipResponseTransform } from "../../common/decorators/skip-response-transform.decorator";
import { ReadThrottle } from "../../common/throttle-tiers";
import { PrismaService } from "../prisma/prisma.service";

/**
 * Liveness/readiness probe. Unauthenticated by necessity — a platform health checker
 * has no session and no API key — so it deliberately reveals nothing beyond whether
 * this instance can serve traffic: no version, no environment, no dependency URLs.
 *
 * @SkipResponseTransform because health checkers match on shape and status code, and
 * wrapping the body in the { success, message, statusCode, payload } envelope every
 * other route uses would leave the real answer nested where a probe won't look for it.
 *
 * A 200 here must mean "this instance can actually do its job", which is why it
 * touches the database rather than just returning a literal: a process that is up but
 * cannot reach Postgres serves nothing but 500s, and a probe that answers "healthy"
 * for it defeats the point of having one.
 */
@Controller("health")
@UseGuards(ThrottlerGuard)
@ReadThrottle()
@SkipResponseTransform()
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @HttpCode(200)
  async check() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch (error) {
      // Logged rather than swallowed: the probe's own 503 says only "not ready",
      // and the reason it isn't ready is the part someone will need.
      this.logger.error("Health check failed — database unreachable", error as Error);
      // 503, not 500: this is "not ready to receive traffic", which is what an
      // orchestrator needs in order to hold requests back or restart the instance,
      // rather than a generic server fault it has no defined response to.
      throw new ServiceUnavailableException("Database unreachable");
    }

    return { status: "ok" };
  }
}
