import { Body, Controller, Get, Header, Inject, Param, Post, Query, Req, Res, StreamableFile } from "@nestjs/common";

import type { Principal } from "./auth.types.js";
import { CurrentPrincipal } from "./current-principal.decorator.js";
import { ArtifactService } from "./artifact.service.js";

@Controller("api/artifacts")
export class ArtifactController {
  constructor(@Inject(ArtifactService) private readonly artifacts: ArtifactService) {}

  @Get(":artifactId/metadata")
  async metadata(@Param("artifactId") artifactId: string, @CurrentPrincipal() principal: Principal) {
    const artifact = await this.artifacts.metadata(principal, artifactId);
    return { ...artifact, storageKey: undefined, resourceUri: `scry://artifact/${artifactId}` };
  }

  @Get(":artifactId")
  @Header("Accept-Ranges", "bytes")
  async stream(
    @Param("artifactId") artifactId: string,
    @CurrentPrincipal() principal: Principal,
    @Req() request: { headers: { range?: string } },
    @Res({ passthrough: true }) response: {
      header(name: string, value: string): void;
      status(code: number): void;
    },
  ) {
    const result = await this.artifacts.range(principal, artifactId, request.headers.range);
    response.header("Content-Type", result.artifact.contentType);
    response.header("Content-Length", String(result.data.byteLength));
    if (result.partial) {
      response.status(206);
      response.header("Content-Range", `bytes ${result.start}-${result.end}/${result.size}`);
    }
    return new StreamableFile(result.data);
  }

  @Get(":artifactId/text")
  text(@Param("artifactId") artifactId: string, @CurrentPrincipal() principal: Principal,
       @Query("offset") offset?: string, @Query("limit") limit?: string) {
    return this.artifacts.text(principal, artifactId, Number(offset ?? 0), Number(limit ?? 65_536));
  }

  @Post(":artifactId/search")
  search(@Param("artifactId") artifactId: string, @CurrentPrincipal() principal: Principal,
         @Body() input: { query: string; maxMatches?: number }) {
    return this.artifacts.search(principal, artifactId, input.query, input.maxMatches);
  }

  @Post(":artifactId/extract-html")
  extract(@Param("artifactId") artifactId: string, @CurrentPrincipal() principal: Principal,
          @Body() input: { selector: string }) {
    return this.artifacts.extractHtml(principal, artifactId, input.selector);
  }
}
