import { Test, TestingModule } from "@nestjs/testing";
import { B2cService } from "./b2c.service";
import { PrismaService } from "../../prisma/prisma.service";
import { DarajaClient } from "../../../infrastructure/daraja/daraja.client";
import { AuditLogService } from "../../audit-log/audit-log.service";
import { AlertsService } from "../../alerts/alerts.service";
import { TenantsService } from "../../tenants/tenants.service";
import { LedgerService } from "../../ledger/ledger.service";
import { InsufficientBalanceException } from "../../ledger/insufficient-balance.exception";

const TENANT_ID = "11111111-2222-3333-4444-555555555555";
const API_KEY_ACTOR = { type: "api_key" as const, id: "key-1" };

const dto = {
  msisdn: "254712345678",
  amountMinorUnits: 500_00,
  remarks: "Refund for order 42",
  commandId: "BusinessPayment" as const,
};

describe("B2cService", () => {
  let service: B2cService;
  let prisma: any;
  let daraja: DarajaClient;
  let alerts: AlertsService;
  let callOrder: string[];

  /** The account/direction pairs written by ledgerEntry.createMany call number `n`. */
  const entriesAt = (n: number) =>
    (prisma.ledgerEntry.createMany.mock.calls[n][0].data as Array<{ account: string; direction: string }>).map(
      ({ account, direction }) => ({ account, direction }),
    );

  beforeEach(async () => {
    callOrder = [];

    prisma = {
      transaction: {
        create: jest.fn(() => {
          callOrder.push("create-transaction");
          return Promise.resolve({ id: "payout-1", amountMinorUnits: dto.amountMinorUnits });
        }),
        update: jest.fn(() => Promise.resolve({ id: "payout-1", amountMinorUnits: dto.amountMinorUnits })),
      },
      ledgerEntry: {
        createMany: jest.fn(() => {
          callOrder.push("ledger-write");
          return Promise.resolve({ count: 2 });
        }),
        // 1,000 collected, nothing spent.
        groupBy: jest.fn(() => Promise.resolve([{ direction: "credit", _sum: { amountMinorUnits: 1_000_00 } }])),
      },
      // No $transaction key: this stands in for an interactive transaction client,
      // which is what LedgerService.assertSufficientBalance insists on.
      $queryRaw: jest.fn(() => {
        callOrder.push("lock");
        return Promise.resolve([{ id: TENANT_ID }]);
      }),
    };
    prisma.withTenantContext = jest.fn((_tenantId: string, fn: (tx: unknown) => unknown) => fn(prisma));

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        B2cService,
        // The real LedgerService — the point of these tests is that the balance check
        // genuinely gates the payout, not that a mock was called.
        LedgerService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: DarajaClient,
          useValue: {
            initiateB2C: jest.fn(() => {
              callOrder.push("daraja");
              return Promise.resolve({ ConversationID: "AG_1", OriginatorConversationID: "oc-1", ResponseCode: "0" });
            }),
          },
        },
        { provide: AuditLogService, useValue: { record: jest.fn() } },
        { provide: AlertsService, useValue: { send: jest.fn() } },
        {
          provide: TenantsService,
          useValue: {
            getMpesaCredentialsForPayout: jest.fn(() =>
              Promise.resolve({
                mpesaConsumerKey: "ck",
                mpesaConsumerSecretEncrypted: "cs",
                shortcode: "600000",
                initiatorName: "testapi",
                securityCredential: "rsa-blob",
              }),
            ),
          },
        },
      ],
    }).compile();

    service = module.get(B2cService);
    daraja = module.get(DarajaClient);
    alerts = module.get(AlertsService);
  });

  describe("initiate", () => {
    it("creates an OUTBOUND B2C transaction", async () => {
      await service.initiate(TENANT_ID, dto, API_KEY_ACTOR);

      expect(prisma.transaction.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            channel: "B2C",
            direction: "OUTBOUND",
            status: "PENDING",
            amountMinorUnits: 500_00,
            msisdn: "254712345678",
          }),
        }),
      );
    });

    // Reserving after the call would leave a window where two payouts both pass the
    // balance check because neither has debited yet.
    it("locks, checks the balance and debits BEFORE calling Daraja", async () => {
      await service.initiate(TENANT_ID, dto, API_KEY_ACTOR);

      expect(callOrder).toEqual(["lock", "create-transaction", "ledger-write", "daraja"]);
    });

    it("writes the reservation pair — tenant_balance down, payout_reserved up", async () => {
      await service.initiate(TENANT_ID, dto, API_KEY_ACTOR);

      expect(entriesAt(0)).toEqual([
        { account: "tenant_balance", direction: "debit" },
        { account: "payout_reserved", direction: "credit" },
      ]);
    });

    it("sends Daraja the same OriginatorConversationID it stored on the row", async () => {
      await service.initiate(TENANT_ID, dto, API_KEY_ACTOR);

      const stored = prisma.transaction.create.mock.calls[0][0].data.originatorConversationId;
      const sent = (daraja.initiateB2C as jest.Mock).mock.calls[0][1].originatorConversationId;

      expect(typeof stored).toBe("string");
      expect(sent).toBe(stored);
    });

    it("converts minor units to whole KES for Daraja", async () => {
      await service.initiate(TENANT_ID, dto, API_KEY_ACTOR);

      expect((daraja.initiateB2C as jest.Mock).mock.calls[0][1].amount).toBe(500);
    });

    // Safaricom accepting the request into its queue is not the money moving. Only
    // the result callback can settle a payout.
    it("moves to PROCESSING, never SETTLED, when Safaricom accepts", async () => {
      const result = await service.initiate(TENANT_ID, dto, API_KEY_ACTOR);

      expect(prisma.transaction.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { status: "PROCESSING", conversationId: "AG_1" },
        }),
      );
      expect(result).toEqual({ transactionId: "payout-1", status: "PROCESSING" });
    });

    it("refuses a payout larger than the balance and never reaches Daraja", async () => {
      prisma.ledgerEntry.groupBy.mockResolvedValue([{ direction: "credit", _sum: { amountMinorUnits: 100_00 } }]);

      await expect(service.initiate(TENANT_ID, dto, API_KEY_ACTOR)).rejects.toBeInstanceOf(InsufficientBalanceException);

      expect(daraja.initiateB2C).not.toHaveBeenCalled();
      expect(prisma.transaction.create).not.toHaveBeenCalled();
      expect(prisma.ledgerEntry.createMany).not.toHaveBeenCalled();
    });

    it("counts an existing reservation against the balance", async () => {
      // 1,000 in, 800 already committed to an in-flight payout — 500 is not available.
      prisma.ledgerEntry.groupBy.mockResolvedValue([
        { direction: "credit", _sum: { amountMinorUnits: 1_000_00 } },
        { direction: "debit", _sum: { amountMinorUnits: 800_00 } },
      ]);

      await expect(service.initiate(TENANT_ID, dto, API_KEY_ACTOR)).rejects.toBeInstanceOf(InsufficientBalanceException);
    });

    describe("when Daraja rejects the request", () => {
      beforeEach(() => {
        (daraja.initiateB2C as jest.Mock).mockRejectedValue(new Error("Invalid Initiator Information"));
      });

      // No result callback is coming for a request Safaricom never accepted, so
      // without this the funds sit in payout_reserved forever.
      it("releases the reservation back to the spendable balance", async () => {
        await expect(service.initiate(TENANT_ID, dto, API_KEY_ACTOR)).rejects.toThrow("Invalid Initiator Information");

        expect(entriesAt(1)).toEqual([
          { account: "payout_reserved", direction: "debit" },
          { account: "tenant_balance", direction: "credit" },
        ]);
      });

      it("marks the payout FAILED", async () => {
        await expect(service.initiate(TENANT_ID, dto, API_KEY_ACTOR)).rejects.toThrow();

        expect(prisma.transaction.update).toHaveBeenCalledWith(
          expect.objectContaining({
            data: { status: "FAILED", failureReason: "daraja_initiation_error" },
          }),
        );
      });

      it("alerts, and re-throws so the caller sees the failure", async () => {
        await expect(service.initiate(TENANT_ID, dto, API_KEY_ACTOR)).rejects.toThrow();

        expect(alerts.send).toHaveBeenCalledWith(expect.objectContaining({ severity: "warning" }));
      });
    });
  });
});
