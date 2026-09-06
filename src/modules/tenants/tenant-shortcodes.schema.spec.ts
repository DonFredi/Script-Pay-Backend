import { createShortcodeSchema } from "./tenant-shortcodes.schema";

/**
 * Regression coverage for docs/decisions.md entry 39: a Daraja security credential
 * pasted with its surrounding JSON quotes stored as `"Ab3dEf…P=="`, encrypted and
 * decrypted flawlessly, and only failed at Safaricom days later as
 * "The initiator information is invalid." — an error naming the initiator, not the
 * credential. These tests pin the stripping so that cannot recur silently.
 */

const b2c = (over: Record<string, unknown> = {}) => ({
  type: "B2C" as const,
  shortcode: "600992",
  initiatorName: "testapi",
  securityCredential: "Ab3dEfGh+/JkLmNoP==",
  ...over,
});

describe("createShortcodeSchema credential normalisation", () => {
  it("strips a matched pair of wrapping double quotes", () => {
    const parsed = createShortcodeSchema.parse(b2c({ securityCredential: '"Ab3dEfGh+/JkLmNoP=="' }));
    expect(parsed.securityCredential).toBe("Ab3dEfGh+/JkLmNoP==");
  });

  it("strips a matched pair of wrapping single quotes", () => {
    const parsed = createShortcodeSchema.parse(b2c({ securityCredential: "'Ab3dEfGh+/JkLmNoP=='" }));
    expect(parsed.securityCredential).toBe("Ab3dEfGh+/JkLmNoP==");
  });

  it("strips surrounding whitespace outside the quotes as well", () => {
    const parsed = createShortcodeSchema.parse(b2c({ securityCredential: '  "Ab3dEfGh+/JkLmNoP=="  ' }));
    expect(parsed.securityCredential).toBe("Ab3dEfGh+/JkLmNoP==");
  });

  it("leaves an unquoted credential exactly as submitted", () => {
    const parsed = createShortcodeSchema.parse(b2c());
    expect(parsed.securityCredential).toBe("Ab3dEfGh+/JkLmNoP==");
  });

  it("does NOT strip an unmatched quote on one side only", () => {
    // Only a matched pair is a paste artefact. A one-sided quote is a value the
    // operator actually submitted, and silently altering it would be worse than
    // passing it through and letting Safaricom reject it.
    const parsed = createShortcodeSchema.parse(b2c({ securityCredential: '"Ab3dEfGh+/JkLmNoP==' }));
    expect(parsed.securityCredential).toBe('"Ab3dEfGh+/JkLmNoP==');
  });

  it("applies the same stripping to initiatorName", () => {
    const parsed = createShortcodeSchema.parse(b2c({ initiatorName: '"testapi"' }));
    expect(parsed.initiatorName).toBe("testapi");
  });

  it("treats a credential of only quotes as absent, failing the B2C requirement", () => {
    expect(() => createShortcodeSchema.parse(b2c({ securityCredential: '""' }))).toThrow();
  });
});
