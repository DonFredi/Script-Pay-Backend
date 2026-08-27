import { Test, TestingModule } from "@nestjs/testing";
import { UnauthorizedException } from "@nestjs/common";
import { hash, verify } from "argon2";
import { AuthService } from "./auth.service";
import { PrismaPrivilegedService } from "../prisma/prisma-privileged.service";
import { TokenService } from "./token.service";
import { RefreshTokenService } from "./refresh-token.service";
import { VerificationTokenService } from "./verification-token.service";
import { EmailService } from "./email.service";
import { AuditLogService } from "../audit-log/audit-log.service";

describe("AuthService", () => {
  let service: AuthService;
  let prisma: PrismaPrivilegedService;

  const now = new Date();
  const baseUser = {
    id: "1",
    username: "testuser",
    email: "test@example.com",
    passwordHash: "hashed",
    emailVerified: false,
    role: "TENANT_ADMIN" as const,
    tenantId: null as string | null,
    createdAt: now,
    updatedAt: now,
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        {
          provide: PrismaPrivilegedService,
          useValue: {
            user: {
              findUnique: jest.fn(),
              findUniqueOrThrow: jest.fn(),
              create: jest.fn(),
              update: jest.fn(),
            },
            refreshToken: {
              create: jest.fn(),
              findUnique: jest.fn(),
              update: jest.fn(),
            },
          },
        },
        {
          provide: TokenService,
          useValue: { signAccessToken: jest.fn().mockResolvedValue("access-token") },
        },
        {
          provide: RefreshTokenService,
          useValue: {
            issue: jest.fn().mockResolvedValue("refresh-token"),
            verifyAndRotate: jest.fn(),
            revoke: jest.fn(),
            revokeAllForUser: jest.fn(),
          },
        },
        {
          provide: VerificationTokenService,
          useValue: {
            issueEmailVerificationToken: jest.fn().mockResolvedValue("verify-token"),
            consumeEmailVerificationToken: jest.fn(),
            issuePasswordResetToken: jest.fn(),
            consumePasswordResetToken: jest.fn(),
          },
        },
        {
          provide: EmailService,
          useValue: {
            sendVerificationEmail: jest.fn().mockResolvedValue(undefined),
            sendPasswordResetEmail: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: AuditLogService,
          useValue: { record: jest.fn().mockResolvedValue(undefined) },
        },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
    prisma = module.get<PrismaPrivilegedService>(PrismaPrivilegedService);
  });

  describe("signup", () => {
    it("should create a new user", async () => {
      const dto = {
        email: "test@example.com",
        password: "test123",
        confirmPassword: "test123",
        username: "testuser",
      };

      jest.spyOn(prisma.user, "findUnique").mockResolvedValueOnce(null);
      jest.spyOn(prisma.user, "create").mockResolvedValueOnce(baseUser);

      const result = await service.signup(dto);

      expect(prisma.user.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            email: dto.email,
          }),
        }),
      );
      expect(result.user.email).toBe(dto.email);
    });

    it("should hash the password before storing it", async () => {
      const dto = {
        email: "test@example.com",
        password: "plain_password",
        confirmPassword: "plain_password",
        username: "testuser",
      };

      jest.spyOn(prisma.user, "findUnique").mockResolvedValueOnce(null);
      const createSpy = jest.spyOn(prisma.user, "create").mockResolvedValueOnce(baseUser);

      await service.signup(dto);

      const storedHash = createSpy.mock.calls[0][0].data.passwordHash;
      expect(storedHash).not.toBe(dto.password);
      await expect(verify(storedHash, dto.password)).resolves.toBe(true);
    });
  });

  describe("login", () => {
    it("should return tokens on valid credentials", async () => {
      const email = "test@example.com";
      const password = "test123";

      const mockUser = {
        ...baseUser,
        email,
        passwordHash: await hash(password),
        tenantId: "tenant-1",
      };

      jest.spyOn(prisma.user, "findUnique").mockResolvedValueOnce(mockUser);

      const result = await service.login({ email, password });

      expect(result.accessToken).toBeDefined();
      expect(result.refreshToken).toBeDefined();
      expect(result.user.email).toBe(email);
    });

    it("should prevent user enumeration", async () => {
      // Both "user not found" and "wrong password" return the same generic error
      jest.spyOn(prisma.user, "findUnique").mockResolvedValueOnce(null);

      await expect(service.login({ email: "nonexistent@example.com", password: "any" })).rejects.toThrow(
        UnauthorizedException,
      );
      await expect(service.login({ email: "nonexistent@example.com", password: "any" })).rejects.toThrow(
        "Invalid email or password",
      );
    });
  });
});
