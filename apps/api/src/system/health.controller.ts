import { Controller, Get } from "@nestjs/common";

import { Public } from "../auth/index.js";

@Controller("api/health")
@Public()
export class HealthController {
  @Get()
  health() {
    return { status: "ok" };
  }
}
