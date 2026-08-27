import { Module } from "@nestjs/common";
import { AuthController } from "./auth.controller";
import { ProfileController } from "./profile.controller";
import { AuthService } from "./auth.service";
import { TokenService } from "./token.service";
import { RefreshTokenService } from "./refresh-token.service";
import { VerificationTokenService } from "./verification-token.service";
import { EmailService } from "./email.service";
import { AccessTokenGuard } from "./access-token.guard";

@Module({
  controllers: [AuthController, ProfileController],
  providers: [AuthService, TokenService, RefreshTokenService, VerificationTokenService, EmailService, AccessTokenGuard],
  // AccessTokenGuard is used by every other module's controllers; EmailService is
  // also needed by TenantsService (auto-provisioned API key notification on activation).
  exports: [TokenService, AccessTokenGuard, EmailService],
})
export class AuthModule {}
