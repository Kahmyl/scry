import { Body, Controller, Get, Inject, Post } from "@nestjs/common";
import { z } from "zod";

import { CurrentPrincipal } from "../../auth/current-principal.decorator.js";
import type { Principal } from "../../auth/auth.types.js";
import { ZodValidationPipe } from "../../common/validation.pipe.js";
import { BrowserProjectRepository } from "../repositories/browser-project.repository.js";

const createProjectSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2_000).default(""),
});

@Controller("api")
export class BrowserProjectController {
  constructor(
    @Inject(BrowserProjectRepository) private readonly projects: BrowserProjectRepository,
  ) {}

  @Get("projects")
  list(@CurrentPrincipal() principal: Principal) {
    return this.projects.list(principal);
  }

  @Post("projects")
  create(
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(createProjectSchema))
    input: z.infer<typeof createProjectSchema>,
  ) {
    return this.projects.create(principal, input);
  }
}
