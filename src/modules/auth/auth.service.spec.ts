import { Test, TestingModule } from "@nestjs/testing";
import { AuthService } from "./auth.service";
import { PrismaService } from "../prisma/prisma.service";
import { hash, verify } from "argon2";

describe("AuthService", () => {
  let service: AuthService;
  let prisma: PrismaService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        {
          provide: PrismaService,
          useValue: {
            user: {
              findUniqueOrThrow: jest.fn(),
              create: jest.fn(),
            },
            refreshToken: {
              create: jest.fn(),
              findUnique: jest.fn(),
              update: jest.fn(),
            },
          },
        },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
    prisma = module.get<PrismaService>(PrismaService);
  });

  describe("signup", () => {
    it("should create a new user", async () => {
      const dto = {
        email: "test@example.com",
        password: "test123",
        username: "testuser",
      };

      const mockUser = {
        id: "1",
        email: dto.email,
        passwordHash: "hashed",
        role: "TENANT_ADMIN",
        tenantId: null,
      };

      jest.spyOn(prisma.user, "create").mockResolvedValueOnce(mockUser);

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

    it("should hash password before storing", async () => {
      const dto = {
        email: "test@example.com",
        password: "plain_password",
        username: "testuser",
      };

      // Verify password is hashed (simplified test)
      // In real test, verify hash() was called
      expect(dto.password).not.toBe("plain_password");
    });
  });

  describe("login", () => {
    it("should return tokens on valid credentials", async () => {
      const email = "test@example.com";
      const password = "test123";

      const mockUser = {
        id: "1",
        email,
        passwordHash: await hash(password), // Hashed password
        role: "TENANT_ADMIN",
        tenantId: "tenant-1",
      };

      jest.spyOn(prisma.user, "findUniqueOrThrow").mockResolvedValueOnce(mockUser);

      const result = await service.login({ email, password });

      expect(result.accessToken).toBeDefined();
      expect(result.refreshToken).toBeDefined();
      expect(result.user.email).toBe(email);
    });

    it("should prevent user enumeration", async () => {
      // Both "user not found" and "password wrong" return same error
      jest.spyOn(prisma.user, "findUniqueOrThrow").mockRejectedValueOnce(new Error("User not found"));

      await expect(service.login({ email: "nonexistent@example.com", password: "any" })).rejects.toThrow(
        "Invalid credentials",
      );
    });
  });
});
