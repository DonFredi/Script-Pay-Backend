import { Injectable } from "@nestjs/common";
import * as argon2 from "argon2";
// import { customAlphabet } from "nanoid";
import { PrismaService } from "../prisma/prisma.service";
import { AuditLogService } from "../audit-log/audit-log.service";
import type { ApiKeyScope } from "@prisma/client";
import { randomBytes } from "crypto";

// A pepper is a second secret, held only in application config (never in the DB),
// mixed in before hashing. A stolen DATABASE backup alone is then insufficient to
// brute-force keys even offline — the attacker also needs this env var, which lives
// in the secrets manager, not the database.
const PEPPER = process.env.API_KEY_HASH_PEPPER ?? "";

@Injectable()
export class ApiKeysService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  /**
   * Returns the raw key EXACTLY ONCE — it is never retrievable again after this call,
   * matching how every other API-key-issuing platform works. Only the argon2 hash and
   * an 8-char prefix (for UI identification) are persisted.
   */
  async create(tenantId: string, scopes: ApiKeyScope[], actorId: string, expiresAt?: Date) {
    const rawKey = `sp_${randomBytes(40).toString("hex")}`;
    const keyHash = await argon2.hash(rawKey + PEPPER);

    const record = await this.prisma.apiKey.create({
      data: { tenantId, keyHash, keyPrefix: rawKey.slice(0, 8), scopes, expiresAt },
    });

    await this.auditLog.record({
      tenantId,
      actorType: "user",
      actorId,
      action: "api_key.created",
      targetType: "ApiKey",
      targetId: record.id,
      metadata: { scopes, keyPrefix: record.keyPrefix }, // never log the raw key or hash
    });

    return { id: record.id, rawKey, keyPrefix: record.keyPrefix, scopes: record.scopes };
  }

  async listForTenant(tenantId: string) {
    // Deliberately excludes keyHash from the select — never return it, even to the owning tenant.
    return this.prisma.apiKey.findMany({
      where: { tenantId },
      select: {
        id: true,
        keyPrefix: true,
        scopes: true,
        lastUsedAt: true,
        revokedAt: true,
        expiresAt: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
    });
  }

  async revoke(tenantId: string, keyId: string, actorId: string) {
    // Scoped by tenantId in the WHERE clause, not just the id — prevents one tenant
    // from revoking another tenant's key by guessing/enumerating IDs.
    const result = await this.prisma.apiKey.updateMany({
      where: { id: keyId, tenantId },
      data: { revokedAt: new Date() },
    });

    if (result.count > 0) {
      await this.auditLog.record({
        tenantId,
        actorType: "user",
        actorId,
        action: "api_key.revoked",
        targetType: "ApiKey",
        targetId: keyId,
      });
    }

    return result;
  }
}
