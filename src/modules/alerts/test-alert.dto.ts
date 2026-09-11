import { z } from "zod";

export const testAlertSchema = z
  .object({
    // Defaults to "critical" deliberately: that's the only severity email
    // carries at all (AlertsService.send, see docs/decisions.md entry 37) —
    // a "warning" test would only ever prove Slack works, if configured, and
    // silently say nothing about the channel most likely to actually page someone.
    severity: z.enum(["warning", "critical"]).default("critical"),
  })
  .strict();

export type TestAlertDto = z.infer<typeof testAlertSchema>;
