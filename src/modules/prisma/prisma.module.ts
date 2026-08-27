import { Global, Module } from "@nestjs/common";
import { PrismaService } from "./prisma.service";
import { PrismaPrivilegedService } from "./prisma-privileged.service";

/**
 * @Global() so every feature module can inject PrismaService (or
 * PrismaPrivilegedService — see its own doc comment for when that's the correct
 * one instead) without importing this module explicitly — reduces boilerplate for
 * what is, correctly, a cross-cutting dependency almost every module needs.
 */
@Global()
@Module({
  providers: [PrismaService, PrismaPrivilegedService],
  exports: [PrismaService, PrismaPrivilegedService],
})
export class PrismaModule {}
