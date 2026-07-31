import { BadRequestException, type PipeTransform } from "@nestjs/common";
import type { ZodType } from "zod";

/**
 * Usage: @Body(new ZodValidationPipe(initiateStkPushSchema)) body: InitiateStkPushDto
 * Keeps runtime validation and the compile-time type derived from the SAME schema —
 * eliminates the class of bugs where a hand-written interface drifts from what's actually validated.
 */
export class ZodValidationPipe implements PipeTransform {
  constructor(private readonly schema: ZodType) {}

  transform(value: unknown) {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException({
        message: "Validation failed",
        issues: result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      });
    }
    return result.data;
  }
}
