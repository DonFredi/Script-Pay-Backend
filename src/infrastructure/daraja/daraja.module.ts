import { Module } from "@nestjs/common";
import { DarajaClient } from "./daraja.client";

@Module({
  providers: [DarajaClient],
  exports: [DarajaClient],
})
export class DarajaModule {}
