import { Injectable } from "@nestjs/common";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";

/**
 * Encrypts Safaricom Consumer Secret / Passkey before they ever touch the
 * database. A stolen database backup alone should never be enough to extract
 * usable Daraja credentials — this is the same principle as API key hashing,
 * but reversible (we need the real value to call Safaricom, not just verify it).
 *
 * CREDENTIALS_ENCRYPTION_KEY must be a 32-byte key, base64-encoded, in env —
 * generate with: openssl rand -base64 32
 */
@Injectable()
export class CredentialsEncryptionService {
  private readonly key = Buffer.from(process.env.CREDENTIALS_ENCRYPTION_KEY ?? "", "base64");

  encrypt(plaintext: string): string {
    const iv = randomBytes(12); // GCM standard IV size
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return `${iv.toString("hex")}:${authTag.toString("hex")}:${ciphertext.toString("hex")}`;
  }

  decrypt(encrypted: string): string {
    const [ivHex, authTagHex, ciphertextHex] = encrypted.split(":");
    const decipher = createDecipheriv(ALGORITHM, this.key, Buffer.from(ivHex, "hex"));
    decipher.setAuthTag(Buffer.from(authTagHex, "hex"));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertextHex, "hex")), decipher.final()]);
    return plaintext.toString("utf8");
  }
}
