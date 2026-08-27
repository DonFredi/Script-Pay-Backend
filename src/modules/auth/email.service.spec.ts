const sendMock = jest.fn();

jest.mock("resend", () => ({
  Resend: jest.fn().mockImplementation(() => ({ emails: { send: sendMock } })),
}));

import { EmailService } from "./email.service";

describe("EmailService", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    sendMock.mockReset();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe("sendApiKeyProvisionedEmail", () => {
    it("sends the raw key via Resend when configured", async () => {
      process.env.RESEND_API_KEY = "re_test";
      process.env.EMAIL_FROM = "no-reply@scriptpay.test";
      const service = new EmailService();

      await service.sendApiKeyProvisionedEmail("owner@tenant.test", "sp_rawvalue123");

      expect(sendMock).toHaveBeenCalledWith(
        expect.objectContaining({
          from: "no-reply@scriptpay.test",
          to: "owner@tenant.test",
          html: expect.stringContaining("sp_rawvalue123"),
        }),
      );
    });

    it("logs instead of throwing when email isn't configured", async () => {
      delete process.env.RESEND_API_KEY;
      delete process.env.EMAIL_FROM;
      const service = new EmailService();

      await expect(service.sendApiKeyProvisionedEmail("owner@tenant.test", "sp_rawvalue123")).resolves.toBeUndefined();
      expect(sendMock).not.toHaveBeenCalled();
    });

    it("never throws when Resend itself throws", async () => {
      process.env.RESEND_API_KEY = "re_test";
      process.env.EMAIL_FROM = "no-reply@scriptpay.test";
      sendMock.mockRejectedValueOnce(new Error("resend down"));
      const service = new EmailService();

      await expect(service.sendApiKeyProvisionedEmail("owner@tenant.test", "sp_rawvalue123")).resolves.toBeUndefined();
    });
  });
});
