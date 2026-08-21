import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import * as Sentry from "@sentry/node";
import cookieParser from "cookie-parser";
import { AppModule } from "./app.module";
import { validateEnv } from "./config/env.schema";



async function bootstrap() {
  // Fail fast on boot if config is invalid — never let a service start in a half-configured state.
  const env = validateEnv(process.env);
console.log("MPESA_CALLBACK_BASE_URL:", process.env.MPESA_CALLBACK_BASE_URL);
  // Initialized before anything else so it can capture errors during the rest of bootstrap too.
  if (env.SENTRY_DSN) {
    Sentry.init({
      dsn: env.SENTRY_DSN,
      environment: env.NODE_ENV,
      tracesSampleRate: env.NODE_ENV === "production" ? 0.2 : 1,
      // Unlike the frontend's Sentry config, this backend handles raw M-Pesa
      // payloads (phone numbers, amounts) — do NOT enable sendDefaultPii here without
      // an explicit beforeSend scrubber. Left off by default, intentionally.
    });
  }

  // No Firebase Admin init here anymore — this backend owns identity directly now
  // (argon2 password hashing, its own access/refresh JWTs). See auth.service.ts.

  const app = await NestFactory.create(AppModule);
  app.use(cookieParser()); // required to read the httpOnly refresh_token cookie in AuthController/ProfileController
  app.enableCors({
    origin: env.FRONTEND_ORIGIN,
    credentials: true, // required for the refresh_token cookie to be sent cross-origin
  });

  await app.listen(env.PORT);
}

bootstrap().catch((error: unknown) => {
  // Boot-time failure (bad config, DB unreachable, etc.) — nothing is listening yet,
  // so there's no request path to report this on. Log and exit non-zero instead of
  // leaving the process hanging in a half-started state.
  console.error("Fatal error during bootstrap:", error);
  process.exit(1);
});
