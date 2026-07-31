import { Injectable } from "@nestjs/common";
import { SignJWT, jwtVerify } from "jose";
import type { Role } from "@prisma/client";

export interface AccessTokenClaims {
  sub: string; // User.id
  email: string;
  role: Role;
  tenantId: string | null;
}

/**
 * Uses `jose`, not `jsonwebtoken` — jose works identically on Node and the Edge
 * runtime, which matters because the frontend's middleware.ts (Edge) needs to
 * verify this exact token format without a Node-only crypto dependency. This is
 * the fix for the earlier Firebase-session approach's core limitation: real,
 * stateless signature verification can now run in Edge middleware.
 */
@Injectable()
export class TokenService {
  private readonly secret = new TextEncoder().encode(process.env.JWT_ACCESS_SECRET);
  private readonly ttlSeconds = Number(process.env.JWT_ACCESS_TTL_SECONDS ?? 900);

  async signAccessToken(claims: AccessTokenClaims): Promise<string> {
    return new SignJWT({ email: claims.email, role: claims.role, tenantId: claims.tenantId })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(claims.sub)
      .setIssuedAt()
      .setExpirationTime(`${this.ttlSeconds}s`)
      .sign(this.secret);
  }

  async verifyAccessToken(token: string): Promise<AccessTokenClaims> {
    const { payload } = await jwtVerify(token, this.secret);
    return {
      sub: payload.sub as string,
      email: payload.email as string,
      role: payload.role as Role,
      tenantId: (payload.tenantId as string | null) ?? null,
    };
  }

  get accessTokenTtlSeconds(): number {
    return this.ttlSeconds;
  }
}
