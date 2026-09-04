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
/**
 * Pinned on every token this service issues and required on every token it accepts.
 * Without them a token is only as scoped as its signing key: anything else that ever
 * shares JWT_ACCESS_SECRET — a future internal service, a reused staging value —
 * would mint tokens this backend accepts as its own sessions. Naming the issuer and
 * audience keeps that a deliberate act rather than an accident of key reuse.
 *
 * Changing either value invalidates every access token already in circulation. That
 * is a 15-minute inconvenience (JWT_ACCESS_TTL_SECONDS), not a logout: the frontend's
 * interceptor silently refreshes on the first 401 and refresh tokens are unaffected.
 */
const JWT_ISSUER = "scriptpay-backend";
const JWT_AUDIENCE = "scriptpay-dashboard";

@Injectable()
export class TokenService {
  private readonly secret = new TextEncoder().encode(process.env.JWT_ACCESS_SECRET);
  private readonly ttlSeconds = Number(process.env.JWT_ACCESS_TTL_SECONDS ?? 900);

  async signAccessToken(claims: AccessTokenClaims): Promise<string> {
    return new SignJWT({ email: claims.email, role: claims.role, tenantId: claims.tenantId })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(claims.sub)
      .setIssuer(JWT_ISSUER)
      .setAudience(JWT_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(`${this.ttlSeconds}s`)
      .sign(this.secret);
  }

  async verifyAccessToken(token: string): Promise<AccessTokenClaims> {
    // Setting the claims without verifying them would be decoration — jose only
    // enforces issuer/audience when asked to.
    const { payload } = await jwtVerify(token, this.secret, {
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    });
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
