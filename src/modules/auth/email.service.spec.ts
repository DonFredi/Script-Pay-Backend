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

  describe("sendApiKeyRotatedEmail", () => {
    it("sends the raw key via Resend when configured", async () => {
      process.env.RESEND_API_KEY = "re_test";
      process.env.EMAIL_FROM = "no-reply@scriptpay.test";
      const service = new EmailService();

      await service.sendApiKeyRotatedEmail("owner@tenant.test", "sp_rawvalue123");

      expect(sendMock).toHaveBeenCalledWith(
        expect.objectContaining({ to: "owner@tenant.test", html: expect.stringContaining("sp_rawvalue123") }),
      );
    });
  });

  describe("sendApiKeyStaffNotice", () => {
    it("never includes a raw key placeholder — only metadata", async () => {
      process.env.RESEND_API_KEY = "re_test";
      process.env.EMAIL_FROM = "no-reply@scriptpay.test";
      const service = new EmailService();

      await service.sendApiKeyStaffNotice(
        "staff@scriptpay.test",
        "ScriptTagg",
        "sp_abcd12",
        ["PAYMENTS_INITIATE"],
        "admin@scripttagg.test",
      );

      expect(sendMock).toHaveBeenCalledWith(
        expect.objectContaining({
          to: "staff@scriptpay.test",
          html: expect.stringContaining("sp_abcd12"),
        }),
      );
    });
  });

  describe("sendWebhookSecretRotatedEmail", () => {
    it("sends the raw secret via Resend when configured", async () => {
      process.env.RESEND_API_KEY = "re_test";
      process.env.EMAIL_FROM = "no-reply@scriptpay.test";
      const service = new EmailService();

      await service.sendWebhookSecretRotatedEmail(
        "owner@tenant.test",
        "whsec_rawvalue123",
        "https://example.com/webhooks",
      );

      expect(sendMock).toHaveBeenCalledWith(
        expect.objectContaining({ to: "owner@tenant.test", html: expect.stringContaining("whsec_rawvalue123") }),
      );
    });

    it("logs instead of throwing when email isn't configured", async () => {
      delete process.env.RESEND_API_KEY;
      delete process.env.EMAIL_FROM;
      const service = new EmailService();

      await expect(
        service.sendWebhookSecretRotatedEmail("owner@tenant.test", "whsec_rawvalue123", "https://example.com/webhooks"),
      ).resolves.toBeUndefined();
      expect(sendMock).not.toHaveBeenCalled();
    });
  });

  describe("sendWebhookSecretStaffNotice", () => {
    it("never includes the raw secret — only metadata", async () => {
      process.env.RESEND_API_KEY = "re_test";
      process.env.EMAIL_FROM = "no-reply@scriptpay.test";
      const service = new EmailService();

      await service.sendWebhookSecretStaffNotice("staff@scriptpay.test", "ScriptTagg", "https://example.com/webhooks");

      expect(sendMock).toHaveBeenCalledWith(
        expect.objectContaining({ to: "staff@scriptpay.test", html: expect.stringContaining("ScriptTagg") }),
      );
    });
  });
});
