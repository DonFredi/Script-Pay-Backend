import { initiateStkPushSchema } from "./stk-push/initiate-stk-push.dto";
import { initiateB2cSchema } from "./b2c/initiate-b2c.dto";

/**
 * Both payment DTOs in one file because the rule under test is the same on each
 * side and the value of it is that they agree: an amount either represents whole
 * shillings M-Pesa can actually move, or it is rejected before anything is
 * reserved, charged or written to the ledger.
 */

const stkBase = {
  msisdn: "254712345678",
  accountReference: "ORDER42",
  transactionDesc: "Order 42",
};

const b2cBase = {
  shortcodeId: "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
  msisdn: "254712345678",
  remarks: "Refund for order 42",
};

const stk = (amountMinorUnits: number) => initiateStkPushSchema.safeParse({ ...stkBase, amountMinorUnits });
const b2c = (amountMinorUnits: number) => initiateB2cSchema.safeParse({ ...b2cBase, amountMinorUnits });

describe("payment amount validation", () => {
  describe("whole-shilling rule", () => {
    // The concrete defect: 150 minor units (KES 1.50) passed validation, was divided
    // by 100 into 1.5, and Daraja's Math.round made it a real KES 2 charge — while
    // the transaction row and every ledger entry still said 150. On the payout side
    // the tenant was debited KES 1.50 for KES 2 that actually left their shortcode.
    it.each([1, 50, 150, 999, 100_01])("rejects %i minor units — not a whole shilling", (amount) => {
      expect(stk(amount).success).toBe(false);
      expect(b2c(amount).success).toBe(false);
    });

    it.each([100, 5_000, 1_000_00])("accepts %i minor units", (amount) => {
      expect(stk(amount).success).toBe(true);
      expect(b2c(amount).success).toBe(true);
    });

    it("explains the rule in shillings, not minor units", () => {
      const result = stk(150);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((i) => /whole number of shillings/.test(i.message))).toBe(true);
      }
    });
  });

  describe("per-transaction ceilings", () => {
    // This read 15_000_00 — KES 15,000, a tenth of the limit its own message
    // claimed — so every legitimate collection between KES 15,000 and 150,000 was
    // rejected by an error asserting a limit the code did not enforce. The frontend
    // has always allowed up to 150,000, so the two disagreed.
    it("accepts an STK push at KES 150,000", () => {
      expect(stk(150_000_00).success).toBe(true);
    });

    it("accepts an STK push at KES 20,000, which the old ceiling wrongly rejected", () => {
      expect(stk(20_000_00).success).toBe(true);
    });

    it("rejects an STK push above KES 150,000", () => {
      expect(stk(150_100_00).success).toBe(false);
    });

    // Deliberately a different number: Safaricom tariffs B2C separately, and the
    // real ceiling varies per tenant's own agreement.
    it("accepts a payout at KES 250,000 and rejects one above it", () => {
      expect(b2c(250_000_00).success).toBe(true);
      expect(b2c(250_100_00).success).toBe(false);
    });
  });

  it("still rejects zero and negative amounts on both paths", () => {
    for (const amount of [0, -100]) {
      expect(stk(amount).success).toBe(false);
      expect(b2c(amount).success).toBe(false);
    }
  });
});
