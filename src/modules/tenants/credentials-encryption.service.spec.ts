import { randomBytes } from "node:crypto";
import { CredentialsEncryptionService } from "./credentials-encryption.service";

describe("CredentialsEncryptionService", () => {
  let service: CredentialsEncryptionService;

  beforeAll(() => {
    process.env.CREDENTIALS_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  });

  beforeEach(() => {
    service = new CredentialsEncryptionService();
  });

  it("round-trips plaintext through encrypt/decrypt", () => {
    const plaintext = "super-secret-daraja-consumer-secret";
    const encrypted = service.encrypt(plaintext);
    expect(service.decrypt(encrypted)).toBe(plaintext);
  });

  it("stores iv:authTag:ciphertext as three hex segments", () => {
    const encrypted = service.encrypt("passkey-value");
    const parts = encrypted.split(":");
    expect(parts).toHaveLength(3);
    for (const part of parts) {
      expect(part).toMatch(/^[0-9a-f]+$/);
    }
  });

  it("never produces the same ciphertext twice for the same plaintext (random IV)", () => {
    const a = service.encrypt("same-value");
    const b = service.encrypt("same-value");
    expect(a).not.toBe(b);
    expect(service.decrypt(a)).toBe("same-value");
    expect(service.decrypt(b)).toBe("same-value");
  });

  it("rejects a tampered ciphertext (GCM auth tag verification fails)", () => {
    const encrypted = service.encrypt("do-not-tamper");
    const [iv, authTag, ciphertext] = encrypted.split(":");
    const tamperedByte = ciphertext.slice(0, 2) === "00" ? "ff" : "00";
    const tampered = `${iv}:${authTag}:${tamperedByte}${ciphertext.slice(2)}`;
    expect(() => service.decrypt(tampered)).toThrow();
  });

  it("rejects a tampered auth tag", () => {
    const encrypted = service.encrypt("do-not-tamper");
    const [iv, authTag, ciphertext] = encrypted.split(":");
    const tamperedByte = authTag.slice(0, 2) === "00" ? "ff" : "00";
    const tampered = `${iv}:${tamperedByte}${authTag.slice(2)}:${ciphertext}`;
    expect(() => service.decrypt(tampered)).toThrow();
  });
});
