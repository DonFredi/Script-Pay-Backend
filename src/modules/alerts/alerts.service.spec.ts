const sendMock = jest.fn();

jest.mock("resend", () => ({
  Resend: jest.fn().mockImplementation(() => ({ emails: { send: sendMock } })),
}));

import { AlertsService } from "./alerts.service";

describe("AlertsService", () => {
  const originalEnv = process.env;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    process.env = { ...originalEnv };
    sendMock.mockReset();
    fetchMock = jest.fn().mockResolvedValue({ ok: true });
    global.fetch = fetchMock as any;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe("send — Slack channel", () => {
    it("posts to the configured Slack webhook", async () => {
      process.env.SLACK_WEBHOOK_URL = "https://hooks.slack.test/webhook";
      const service = new AlertsService();

      await service.send({ title: "Drift detected", detail: "Transaction stuck", severity: "warning" });

      expect(fetchMock).toHaveBeenCalledWith(
        "https://hooks.slack.test/webhook",
        expect.objectContaining({ method: "POST" }),
      );
    });

    it("never throws when Slack is unreachable — logs instead", async () => {
      process.env.SLACK_WEBHOOK_URL = "https://hooks.slack.test/webhook";
      fetchMock.mockRejectedValueOnce(new Error("network down"));
      const service = new AlertsService();

      await expect(
        service.send({ title: "Drift detected", detail: "Transaction stuck", severity: "warning" }),
      ).resolves.toBeUndefined();
    });

    it("logs instead of throwing when SLACK_WEBHOOK_URL isn't configured", async () => {
      delete process.env.SLACK_WEBHOOK_URL;
      const service = new AlertsService();

      await expect(
        service.send({ title: "Drift detected", detail: "Transaction stuck", severity: "warning" }),
      ).resolves.toBeUndefined();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("send — redundant email channel for critical alerts", () => {
    it("also emails ALERTS_EMAIL_TO for a critical alert when email is configured", async () => {
      process.env.RESEND_API_KEY = "re_test";
      process.env.EMAIL_FROM = "alerts@scriptpay.test";
      process.env.ALERTS_EMAIL_TO = "ops@scriptpay.test";
      const service = new AlertsService();

      await service.send({ title: "Daraja unreachable", detail: "STK push failing", severity: "critical" });

      expect(sendMock).toHaveBeenCalledWith(
        expect.objectContaining({ to: "ops@scriptpay.test", subject: "[ScriptPay] Daraja unreachable" }),
      );
    });

    it("does not email a warning-severity alert, even with ALERTS_EMAIL_TO configured", async () => {
      process.env.RESEND_API_KEY = "re_test";
      process.env.EMAIL_FROM = "alerts@scriptpay.test";
      process.env.ALERTS_EMAIL_TO = "ops@scriptpay.test";
      const service = new AlertsService();

      await service.send({ title: "Minor hiccup", detail: "Not urgent", severity: "warning" });

      expect(sendMock).not.toHaveBeenCalled();
    });

    it("skips the email channel silently when ALERTS_EMAIL_TO isn't set, even for critical", async () => {
      process.env.RESEND_API_KEY = "re_test";
      process.env.EMAIL_FROM = "alerts@scriptpay.test";
      delete process.env.ALERTS_EMAIL_TO;
      const service = new AlertsService();

      await expect(
        service.send({ title: "Daraja unreachable", detail: "STK push failing", severity: "critical" }),
      ).resolves.toBeUndefined();
      expect(sendMock).not.toHaveBeenCalled();
    });
  });

  describe("sendEmail", () => {
    it("sends via Resend when configured", async () => {
      process.env.RESEND_API_KEY = "re_test";
      process.env.EMAIL_FROM = "alerts@scriptpay.test";
      const service = new AlertsService();

      await service.sendEmail("someone@example.com", "Subject", "<p>Body</p>");

      expect(sendMock).toHaveBeenCalledWith({
        from: "alerts@scriptpay.test",
        to: "someone@example.com",
        subject: "Subject",
        html: "<p>Body</p>",
      });
    });

    it("logs instead of throwing when Resend isn't configured", async () => {
      delete process.env.RESEND_API_KEY;
      delete process.env.EMAIL_FROM;
      const service = new AlertsService();

      await expect(service.sendEmail("someone@example.com", "Subject", "<p>Body</p>")).resolves.toBeUndefined();
      expect(sendMock).not.toHaveBeenCalled();
    });

    it("never throws when Resend itself throws", async () => {
      process.env.RESEND_API_KEY = "re_test";
      process.env.EMAIL_FROM = "alerts@scriptpay.test";
      sendMock.mockRejectedValueOnce(new Error("resend down"));
      const service = new AlertsService();

      await expect(service.sendEmail("someone@example.com", "Subject", "<p>Body</p>")).resolves.toBeUndefined();
    });
  });
});
