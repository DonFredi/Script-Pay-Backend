import { Test, TestingModule } from "@nestjs/testing";
import { StkPushService } from "./stk-push.service";
import { PrismaService } from "../../prisma/prisma.service";
import { DarajaClient } from "../../../infrastructure/daraja/daraja.client";
import { AuditLogService } from "../../audit-log/audit-log.service";
import { AlertsService } from "../../alerts/alerts.service";
import { TenantsService } from "../../tenants/tenants.service";

describe("StkPushService", () => {
  let service: StkPushService;
  let prisma: PrismaService;
  let daraja: DarajaClient;

  beforeEach(async () => {
    const prismaMock: any = {
      transaction: {
        create: jest.fn(),
        update: jest.fn(),
      },
    };
    // Mirrors PrismaService.withTenantContext's real signature, running the callback
    // against this same mock rather than a real transaction.
    prismaMock.withTenantContext = jest.fn((_tenantId: string, fn: (tx: unknown) => unknown) => fn(prismaMock));

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StkPushService,
        { provide: PrismaService, useValue: prismaMock },
        {
          provide: DarajaClient,
          useValue: {
            initiateStkPush: jest.fn(),
          },
        },
        {
          provide: AuditLogService,
          useValue: { record: jest.fn() },
        },
        {
          provide: AlertsService,
          useValue: { send: jest.fn() },
        },
        {
          provide: TenantsService,
          useValue: {
            getMpesaCredentialsForPayment: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<StkPushService>(StkPushService);
    prisma = module.get<PrismaService>(PrismaService);
    daraja = module.get<DarajaClient>(DarajaClient);
  });

  describe("initiate", () => {
    it("should create transaction and call Daraja once", async () => {
      const dto = {
        msisdn: "254712345678",
        amountMinorUnits: 10000,
        accountReference: "REF-001",
        transactionDesc: "Test payment",
        channel: "PAYBILL" as const,
        metadata: {},
      };

      const mockTransaction = { id: "tx-1", status: "PENDING" } as any;
      const mockDarajaResponse = {
        MerchantRequestID: "mr-1",
        CheckoutRequestID: "cr-1",
        ResponseCode: "0",
      };

      jest.spyOn(prisma.transaction, "create").mockResolvedValueOnce(mockTransaction);
      jest.spyOn(daraja, "initiateStkPush").mockResolvedValueOnce(mockDarajaResponse);
      jest.spyOn(prisma.transaction, "update").mockResolvedValueOnce({
        ...mockTransaction,
        status: "PROCESSING",
      });

      const result = await service.initiate("tenant-1", dto);

      // Verify Daraja called only once (not duplicate!)
      expect(daraja.initiateStkPush).toHaveBeenCalledTimes(1);
      expect(result.transactionId).toBe("tx-1");

      // Both DB writes run under the tenant's RLS context — and as two separate
      // calls, not one transaction spanning the Daraja HTTP call in between.
      expect(prisma.withTenantContext).toHaveBeenCalledWith("tenant-1", expect.any(Function));
      expect(prisma.withTenantContext).toHaveBeenCalledTimes(2);
    });

    it("should handle Daraja errors gracefully", async () => {
      const dto = {
        msisdn: "254712345678",
        amountMinorUnits: 10000,
        accountReference: "REF-001",
        transactionDesc: "Test payment",
        channel: "PAYBILL" as const,
        metadata: {},
      };

      jest.spyOn(prisma.transaction, "create").mockResolvedValueOnce({
        id: "tx-1",
        status: "PENDING",
      } as any);

      jest.spyOn(daraja, "initiateStkPush").mockRejectedValueOnce(new Error("Daraja API error"));

      await expect(service.initiate("tenant-1", dto)).rejects.toThrow();

      // Verify transaction marked as FAILED
      expect(prisma.transaction.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: "FAILED",
          }),
        }),
      );
      // The failure-path write still runs under the tenant's RLS context, same as the
      // success path — this is exactly the write a forgotten tenantId filter would miss.
      expect(prisma.withTenantContext).toHaveBeenCalledWith("tenant-1", expect.any(Function));
    });
  });
});
