import { BadRequestException } from "@nestjs/common";
import { z } from "zod";
import { ZodValidationPipe } from "./zod-validation.pipe";

describe("ZodValidationPipe", () => {
  const schema = z.object({
    msisdn: z.string().regex(/^254\d{9}$/),
    amountMinorUnits: z.number().int().positive(),
  });

  it("returns the parsed value unchanged when validation passes", () => {
    const pipe = new ZodValidationPipe(schema);
    const input = { msisdn: "254712345678", amountMinorUnits: 10000 };

    expect(pipe.transform(input)).toEqual(input);
  });

  it("strips unknown/extra fields the schema doesn't define, if the schema is strict about shape", () => {
    // Plain z.object() by default strips unrecognized keys on parse.
    const pipe = new ZodValidationPipe(schema);

    const result = pipe.transform({ msisdn: "254712345678", amountMinorUnits: 10000, extra: "nope" });

    expect(result).not.toHaveProperty("extra");
  });

  it("throws BadRequestException on invalid input", () => {
    const pipe = new ZodValidationPipe(schema);

    expect(() => pipe.transform({ msisdn: "not-a-phone", amountMinorUnits: -5 })).toThrow(BadRequestException);
  });

  it("reports every failing field, not just the first", () => {
    const pipe = new ZodValidationPipe(schema);

    expect.assertions(1);
    try {
      pipe.transform({ msisdn: "bad", amountMinorUnits: -5 });
    } catch (error) {
      const response = (error as BadRequestException).getResponse() as { issues: { path: string }[] };
      const paths = response.issues.map((i) => i.path);
      expect(paths).toEqual(expect.arrayContaining(["msisdn", "amountMinorUnits"]));
    }
  });

  it("never leaks the submitted value itself into the error, only field paths and messages", () => {
    const pipe = new ZodValidationPipe(schema);

    expect.assertions(1);
    try {
      pipe.transform({ msisdn: "254799999999-secret-looking-value", amountMinorUnits: 1 });
    } catch (error) {
      const response = (error as BadRequestException).getResponse();
      expect(JSON.stringify(response)).not.toContain("254799999999-secret-looking-value");
    }
  });
});
