import { Module } from "@nestjs/common";
import { HealthController } from "./health.controller";

/**
 * PrismaModule is global (see prisma.module.ts), so PrismaService needs no import
 * here — the controller is the whole module.
 */
@Module({
  controllers: [HealthController],
})
export class HealthModule {}
