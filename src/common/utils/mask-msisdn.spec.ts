import { maskMsisdn } from "./mask-msisdn";

describe("maskMsisdn", () => {
  it("masks the middle digits of a normal Kenyan MSISDN", () => {
    expect(maskMsisdn("254712345678")).toBe("254712****78");
  });

  it("never returns the full number for a too-short input", () => {
    const result = maskMsisdn("12345");

    expect(result).toBe("****");
    expect(result).not.toContain("12345");
  });

  it("preserves the first 6 and last 2 characters only", () => {
    const masked = maskMsisdn("254799999999");

    expect(masked.startsWith("254799")).toBe(true);
    expect(masked.endsWith("99")).toBe(true);
    expect(masked).toContain("****");
  });
});
