import { Global, Module } from "@nestjs/common";
import { PrismaService } from "./prisma.service";

/**
 * @Global() so every feature module can inject PrismaService without importing
 * this module explicitly — reduces boilerplate for what is, correctly, a
 * cross-cutting dependency almost every module needs.
 */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
