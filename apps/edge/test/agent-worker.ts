// Test-only entrypoint. These hooks are absent from the production bundle.
export { default, ProviderGate } from "../src/index";
import { ProjectRoom as BaseRoom } from "../src/room";
import { AgentCanvas } from "../src/room/agent-canvas";
import { ChildRuns } from "../src/room/children";
import { AgentOCR } from "../src/room/ocr";
import { RunTools } from "../src/room/run-tools";
import { one, requireRow, publicError } from "../src/core";
import type { Row } from "../src/types";
class ExposedTools extends RunTools {
  read(run: Row) { return this.readCanvas(run); }
}
export class ProjectRoom extends BaseRoom {
  override async fetch(request: Request) {
    const path = new URL(request.url).pathname;
    if (!path.startsWith("/fixture/")) return super.fetch(request);
    const data = await request.json() as { projectId:string;runId:string;key:string;args:unknown;role?:string;allowed?:string[] };
    const run = requireRow(await one(this.context.env,"SELECT * FROM runs WHERE id=?",data.runId)
      || await one(this.context.env,"SELECT * FROM child_runs WHERE id=?",data.runId));
    try {
      // Provider I/O must stay outside the DO mutation gate even in tests.
      if (path === "/fixture/tick") {
        await new ChildRuns(this.context).tick(run);
        return Response.json({ok:true});
      }
      return await this.lock(async () => {
        const children = new ChildRuns(this.context);
        const value = path === "/fixture/delegate" ? await children.create(run,data.key,data.args)
          : path === "/fixture/apply" ? await new AgentCanvas(this.context).apply(run,data.key,data.args)
          : path === "/fixture/read" ? await new ExposedTools(this.context).read(run)
          : await new AgentOCR(this.context).read(run,data.args,data.allowed || [],data.role);
        return Response.json(value);
      });
    } catch (error) {
      const e = publicError(error);
      return Response.json(e.body(),{status:e.status});
    }
  }
}
