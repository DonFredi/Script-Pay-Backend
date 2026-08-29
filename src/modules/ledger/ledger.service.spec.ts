import { Test, TestingModule } from "@nestjs/testing";
import { NotFoundException } from "@nestjs/common";
import { LedgerService } from "./ledger.service";
import { InsufficientBalanceException } from "./insufficient-balance.exception";

const TENANT_ID = "11111111-2222-3333-4444-555555555555";

/** Shape of a Prisma groupBy row for ledger_entries grouped by direction. */
const group = (direction: string, amountMinorUnits: number) => ({
  direction,
  _sum: { amountMinorUnits },
});

describe("LedgerService", () => {
  let service: LedgerService;
  let tx: any;
  let callOrder: string[];

  beforeEach(async () => {
    callOrder = [];

    // Deliberately has no $transaction property — that's what an interactive
    // transaction client looks like, and what assertInsideTransaction checks for.
    tx = {
      ledgerEntry: {
        groupBy: jest.fn(async () => {
          callOrder.push("balance");
          return [];
        }),
      },
      $queryRaw: jest.fn(async () => {
        callOrder.push("lock");
        return [{ id: TENANT_ID }];
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [LedgerService],
    }).compile();

    service = module.get<LedgerService>(LedgerService);
  });

  describe("availableBalance", () => {
    it("returns credits minus debits", async () => {
      tx.ledgerEntry.groupBy.mockResolvedValue([group("credit", 150_00), group("debit", 40_00)]);

      await expect(service.availableBalance(tx, TENANT_ID)).resolves.toBe(110_00);
    });

    it("returns 0 when the tenant has no ledger entries at all", async () => {
      tx.ledgerEntry.groupBy.mockResolvedValue([]);

      await expect(service.availableBalance(tx, TENANT_ID)).resolves.toBe(0);
    });

    it("handles a credit-only history (a tenant that has collected but never paid out)", async () => {
      tx.ledgerEntry.groupBy.mockResolvedValue([group("credit", 500_00)]);

      await expect(service.availableBalance(tx, TENANT_ID)).resolves.toBe(500_00);
    });

    it("scopes the sum to this tenant's tenant_balance account only", async () => {
      tx.ledgerEntry.groupBy.mockResolvedValue([]);

      await service.availableBalance(tx, TENANT_ID);

      expect(tx.ledgerEntry.groupBy).toHaveBeenCalledWith(
        expect.objectContaining({
          by: ["direction"],
          where: { tenantId: TENANT_ID, account: "tenant_balance" },
        }),
      );
    });
  });

  describe("lockTenantBalance", () => {
    it("issues a SELECT ... FOR UPDATE against the tenant row", async () => {
      await service.lockTenantBalance(tx, TENANT_ID);

      const [sqlFragments, ...values] = tx.$queryRaw.mock.calls[0];
      expect(sqlFragments.join("")).toMatch(/FOR UPDATE/);
      // Passed as a bound parameter, never interpolated into the SQL text.
      expect(values).toEqual([TENANT_ID]);
    });

    it("throws NotFound rather than treating a missing tenant as a zero balance", async () => {
      tx.$queryRaw.mockResolvedValue([]);

      await expect(service.lockTenantBalance(tx, TENANT_ID)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe("assertSufficientBalance", () => {
    it("returns the verified balance when funds cover the payout", async () => {
      tx.ledgerEntry.groupBy.mockResolvedValue([group("credit", 1_000_00)]);

      await expect(service.assertSufficientBalance(tx, TENANT_ID, 600_00)).resolves.toBe(1_000_00);
    });

    it("allows a payout for the exact available balance", async () => {
      tx.ledgerEntry.groupBy.mockResolvedValue([group("credit", 600_00)]);

      await expect(service.assertSufficientBalance(tx, TENANT_ID, 600_00)).resolves.toBe(600_00);
    });

    it("rejects a payout one cent over the available balance", async () => {
      tx.ledgerEntry.groupBy.mockResolvedValue([group("credit", 600_00)]);

      await expect(service.assertSufficientBalance(tx, TENANT_ID, 600_01)).rejects.toBeInstanceOf(
        InsufficientBalanceException,
      );
    });

    it("counts existing reservations against the balance", async () => {
      // 1,000 collected, 800 already committed to an in-flight payout — only 200 is
      // spendable, even though nothing has failed and no money has moved yet.
      tx.ledgerEntry.groupBy.mockResolvedValue([group("credit", 1_000_00), group("debit", 800_00)]);

      await expect(service.assertSufficientBalance(tx, TENANT_ID, 300_00)).rejects.toBeInstanceOf(
        InsufficientBalanceException,
      );
    });

    it("reports both amounts on the exception", async () => {
      tx.ledgerEntry.groupBy.mockResolvedValue([group("credit", 50_00)]);

      await expect(service.assertSufficientBalance(tx, TENANT_ID, 75_00)).rejects.toMatchObject({
        availableMinorUnits: 50_00,
        requestedMinorUnits: 75_00,
      });
    });

    // The ordering IS the safety property: reading the balance before taking the
    // lock leaves the exact race this method exists to close.
    it("takes the row lock before reading the balance", async () => {
      tx.ledgerEntry.groupBy.mockImplementation(async () => {
        callOrder.push("balance");
        return [group("credit", 1_000_00)];
      });

      await service.assertSufficientBalance(tx, TENANT_ID, 100_00);

      expect(callOrder).toEqual(["lock", "balance"]);
    });

    it.each([
      ["zero", 0],
      ["negative", -100_00],
      ["fractional", 100.5],
    ])("refuses a %s amount before touching the database", async (_label, amount) => {
      await expect(service.assertSufficientBalance(tx, TENANT_ID, amount)).rejects.toThrow(
        /positive integer in minor units/,
      );

      expect(tx.$queryRaw).not.toHaveBeenCalled();
      expect(tx.ledgerEntry.groupBy).not.toHaveBeenCalled();
    });

    it("refuses a client that is not inside a transaction", async () => {
      // A plain PrismaClient exposes $transaction; the itx client does not. Running
      // here would release the FOR UPDATE lock immediately and guarantee nothing.
      const bareClient = { ...tx, $transaction: jest.fn() };

      await expect(service.assertSufficientBalance(bareClient, TENANT_ID, 100_00)).rejects.toThrow(
        /must run inside a transaction/,
      );

      expect(bareClient.$queryRaw).not.toHaveBeenCalled();
    });
  });
});
