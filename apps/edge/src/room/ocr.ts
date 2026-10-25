import { z } from "zod";
import { ApiError, all, requireRow, one } from "../core";
import type { Row } from "../types";
import { RoomService } from "./context";

export const ocrArgs = z.object({ snapshotId: z.string().min(1), language: z.string().max(50).default("auto") }).strict();
/** OCR is computed by the browser. Missing evidence must never look like empty OCR. */
export class AgentOCR extends RoomService {
  async read(run: Row, raw: unknown, allowedSnapshotIds: string[], role = "orchestrator") {
    const args = ocrArgs.parse(raw);
    if (!["orchestrator", "reference-review", "quality-review"].includes(role) || !allowedSnapshotIds.includes(args.snapshotId))
      throw new ApiError("FORBIDDEN", "此角色无权读取该快照的 OCR", 403);
    const snapshot = requireRow(await one(this.env, "SELECT * FROM appearance_snapshots WHERE id=? AND project_id=?", args.snapshotId, run.project_id));
    const rows = await all(this.env, "SELECT * FROM media_artifacts WHERE project_id=? AND user_id=? AND ocr_regions IS NOT NULL ORDER BY rowid DESC", run.project_id, run.user_id);
    const row = rows.find((r) => {
      const p = JSON.parse(r.provenance) as { sourceSnapshotId?: string; op?: string; params?: { language?: string } };
      return p.sourceSnapshotId === args.snapshotId && p.op === "ocr" && (p.params?.language || "auto") === args.language;
    });
    if (!row) throw new ApiError("OCR_UNAVAILABLE", "此快照尚无浏览器 OCR 结果，请在前端执行 OCR 后重试", 422, true, { snapshotId: args.snapshotId, language: args.language });
    const provenance = JSON.parse(row.provenance) as { engine: { name: string; version: string; modelSha256: string } };
    const regions = z.array(z.object({ x:z.number(), y:z.number(), width:z.number(), height:z.number(), text:z.string(), confidence:z.number().optional() })).parse(JSON.parse(row.ocr_regions));
    return { ok: true, data: {
      snapshotId: args.snapshotId, language: args.language, artifactId: row.id,
      ocrModelVersion: `${provenance.engine.name}:${provenance.engine.version}:${provenance.engine.modelSha256}`,
      regions: regions.map((r, i) => ({ id:`${row.id}:${i}`, name:`区域 ${i + 1}`, text:r.text, confidence:r.confidence ?? null,
        quad:[[r.x/snapshot.width,r.y/snapshot.height],[(r.x+r.width)/snapshot.width,r.y/snapshot.height],[(r.x+r.width)/snapshot.width,(r.y+r.height)/snapshot.height],[r.x/snapshot.width,(r.y+r.height)/snapshot.height]] })),
    } };
  }
}
