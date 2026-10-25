import {
  canvasSchema,
  type Canvas,
  type ClientArtifact,
  type ClientResultRequest,
} from "@loomic/shared/edge";
import {
  ApiError,
  assetView,
  configuredInt,
  hash,
  id,
  now,
  one,
  owned,
  quotaDay,
  stmt,
} from "../core";
import { assetBytes, decodePixels } from "../images";
import { placeBatch, worldBounds } from "../placement";
import type { Row } from "../types";
import { RoomService, type EventInput } from "./context";
import { imageElement } from "./elements";
import { appendIndex } from "./indexes";
type Source = { snapshot: Row; asset: Row };
export class ClientResults extends RoomService {
  async register(userId: string, data: ClientResultRequest) {
    const project = await owned(this.env, "projects", data.projectId, userId);
    const digest = await hash(JSON.stringify(data));
    const old = await one(
      this.env,
      "SELECT request_hash,response FROM client_ops WHERE user_id=? AND client_op_id=?",
      userId,
      data.clientOpId,
    );
    if (old) {
      if (old.request_hash !== digest)
        throw new ApiError("IDEMPOTENCY_MISMATCH", "相同操作 ID 的内容不同", 409);
      return JSON.parse(old.response) as unknown;
    }
    const source = await this.source(userId, data);
    const asset = await this.validateResult(userId, data, source);
    const artifactId = id("artifact"),
      snapshotId = asset ? id("snapshot") : null;
    const provenance = {
      sourceSnapshotId: data.sourceSnapshotId,
      op: data.op,
      params: data.params,
      engine: data.engine,
    };
    const artifact: ClientArtifact = {
      id: artifactId,
      taskId: null,
      asset: asset ? (assetView(asset) as NonNullable<ClientArtifact["asset"]>) : null,
      snapshotId,
      provenance,
      ...("ocrRegions" in data.result ? { ocrRegions: data.result.ocrRegions } : {}),
    };
    const canvas = canvasSchema.parse(JSON.parse(project.canvas));
    const insertion = this.insert(canvas, source, artifact);
    const response = { artifact, revision: canvas.revision, elementIds: insertion.elementIds };
    const { writes, events } = await this.registrationWrites(
      userId,
      data,
      digest,
      source,
      asset,
      response,
      canvas,
      insertion.ops,
    );
    try {
      await this.atomic(data.projectId, writes, events);
    } catch (error) {
      const raced = await one(
        this.env,
        "SELECT request_hash,response FROM client_ops WHERE user_id=? AND client_op_id=?",
        userId,
        data.clientOpId,
      );
      if (raced) {
        if (raced.request_hash !== digest)
          throw new ApiError("IDEMPOTENCY_MISMATCH", "相同操作 ID 的内容不同", 409);
        return JSON.parse(raced.response) as unknown;
      }
      if (error instanceof Error && error.message.includes("client_ops_quota"))
        throw new ApiError("QUOTA_EXCEEDED", "今日浏览器处理次数已用尽", 429, false);
      throw error;
    }
    return response;
  }
  private async registrationWrites(
    userId: string,
    data: ClientResultRequest,
    digest: string,
    source: Source,
    asset: Row | null,
    response: { artifact: ClientArtifact; revision: number; elementIds: string[] },
    canvas: Canvas,
    ops: import("@loomic/shared/edge").CanvasOp[],
  ) {
    const { artifact } = response;
    const artifactId = artifact.id,
      snapshotId = artifact.snapshotId,
      provenance = artifact.provenance;
    const writes = [
      stmt(
        this.env,
        "INSERT INTO client_ops VALUES(?,?,?,?,?,?,?)",
        userId,
        data.clientOpId,
        data.projectId,
        quotaDay(),
        configuredInt(this.env.QUOTA_CLIENT_OPS_DAILY ?? "100"),
        digest,
        JSON.stringify(response),
      ),
      stmt(
        this.env,
        "INSERT INTO media_artifacts VALUES(?,?,?,?,?,?,?,?)",
        artifactId,
        data.projectId,
        userId,
        asset?.id ?? null,
        snapshotId,
        JSON.stringify(provenance),
        "ocrRegions" in data.result ? JSON.stringify(data.result.ocrRegions) : null,
        now(),
      ),
    ];
    if (asset)
      writes.splice(
        1,
        0,
        stmt(
          this.env,
          "INSERT INTO appearance_snapshots VALUES(?,?,?,?,?,?,?,?,?,?)",
          snapshotId,
          userId,
          data.projectId,
          source.asset.id,
          asset.id,
          `client:${artifactId}`,
          digest,
          "{}",
          asset.width,
          asset.height,
        ),
      );
    writes.push(...(await this.canvasWrites(data.projectId, data.clientOpId, digest, canvas, ops)));
    const events: EventInput[] = ops.length
      ? [
          {
            type: "canvas.ops",
            payload: { revision: canvas.revision, ops: ops, source: "task" },
          },
        ]
      : [];
    events.push({
      type: "artifact.committed",
      payload: { artifact, elementIds: response.elementIds, revision: canvas.revision },
    });
    return { writes, events };
  }
  private async source(userId: string, data: ClientResultRequest): Promise<Source> {
    const snapshot = await owned(this.env, "appearance_snapshots", data.sourceSnapshotId, userId);
    const asset = await owned(this.env, "assets", snapshot.asset_id, userId);
    if (snapshot.project_id !== data.projectId || asset.project_id !== data.projectId)
      throw new ApiError("FORBIDDEN", "快照不属于当前项目", 403);
    return { snapshot, asset };
  }
  private async validateResult(userId: string, data: ClientResultRequest, source: Source) {
    if ("ocrRegions" in data.result) {
      if (
        data.result.ocrRegions.some(
          (b) => b.x + b.width > source.snapshot.width || b.y + b.height > source.snapshot.height,
        )
      )
        throw new ApiError("INVALID_INPUT", "OCR 区域超出快照", 422);
      return null;
    }
    const resultId = "assetId" in data.result ? data.result.assetId : data.result.svgAssetId;
    const asset = await owned(this.env, "assets", resultId, userId);
    if (asset.project_id !== data.projectId)
      throw new ApiError("FORBIDDEN", "结果资源不属于当前项目", 403);
    if (asset.width > 4096 || asset.height > 4096 || asset.width * asset.height > 4194304)
      throw new ApiError("MEDIA_LIMIT_EXCEEDED", "浏览器结果上限为 4MP、单边 4096 像素", 422);
    if (data.op === "vectorize") {
      if (asset.mime !== "image/svg+xml")
        throw new ApiError("INVALID_INPUT", "矢量化结果必须为 SVG", 422);
    } else {
      if (asset.mime === "image/svg+xml")
        throw new ApiError("INVALID_INPUT", "此操作需要位图结果", 422);
      const bytes = await assetBytes(this.env, asset);
      const pixels = await decodePixels(bytes, asset.mime, 4194304, 4096);
      if (pixels.width !== asset.width || pixels.height !== asset.height)
        throw new ApiError("INVALID_INPUT", "结果尺寸不一致", 422);
      if (data.op === "remove_bg" && !hasAlpha(bytes, asset.mime, pixels.data))
        throw new ApiError("INVALID_INPUT", "去背景结果必须带 alpha 通道", 422);
    }
    const width = source.snapshot.width,
      height = source.snapshot.height;
    if (
      data.op === "upscale"
        ? asset.width <= width ||
          asset.height <= height ||
          asset.width * height !== asset.height * width
        : asset.width !== width || asset.height !== height
    )
      throw new ApiError(
        "INVALID_INPUT",
        data.op === "upscale" ? "超分必须等比例放大" : "结果必须与源快照同尺寸",
        422,
      );
    return asset;
  }
  private insert(canvas: Canvas, source: Source, artifact: ClientArtifact) {
    if (!artifact.asset) return { elementIds: [], ops: [] };
    const sourceElement = canvas.elements.find(
      (e) => !e.isDeleted && e.fileId === source.snapshot.asset_id,
    );
    const element = imageElement(artifact.id, artifact.asset, {
      artifactId: artifact.id,
      snapshotId: artifact.snapshotId,
    });
    element.index = appendIndex(canvas.elements);
    const placed = placeBatch(
      [element],
      canvas.elements,
      sourceElement ? worldBounds(sourceElement) : undefined,
    );
    canvas.elements.push(...placed);
    canvas.files[artifact.asset.id] = { assetId: artifact.asset.id };
    canvas.revision++;
    return {
      elementIds: placed.map((e) => e.id),
      ops: placed.map((element) => ({ kind: "upsert" as const, element })),
    };
  }
  private async canvasWrites(
    projectId: string,
    clientOpId: string,
    digest: string,
    canvas: Canvas,
    ops: import("@loomic/shared/edge").CanvasOp[],
  ) {
    if (!ops.length) return [];
    return [
      stmt(this.env, "UPDATE projects SET canvas=? WHERE id=?", JSON.stringify(canvas), projectId),
      stmt(
        this.env,
        "INSERT INTO operations VALUES(?,?,?,?,?,?,?,?,?)",
        id("op"),
        projectId,
        `client-result:${clientOpId}`,
        digest,
        "task",
        canvas.revision - 1,
        canvas.revision,
        JSON.stringify({ before: [], after: ops }),
        now(),
      ),
      ...ops.map((op) =>
        stmt(
          this.env,
          "INSERT INTO element_revisions VALUES(?,?,?)",
          projectId,
          op.kind === "upsert" ? op.element.id : op.elementId,
          canvas.revision,
        ),
      ),
    ];
  }
}
function hasAlpha(bytes: Uint8Array, mime: string, rgba: Uint8ClampedArray) {
  if (mime === "image/png" && [4, 6].includes(bytes[25])) return true;
  if (mime === "image/png") {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let offset = 8; offset + 12 <= bytes.length; ) {
      if (String.fromCharCode(...bytes.subarray(offset + 4, offset + 8)) === "tRNS") return true;
      offset += view.getUint32(offset) + 12;
    }
  }
  if (mime === "image/webp" && bytes.length >= 30) {
    const chunk = String.fromCharCode(...bytes.subarray(12, 16));
    if (chunk === "VP8X" && bytes[20] & 16) return true;
    if (chunk === "VP8L" && bytes[24] & 16) return true;
  }
  return mime === "image/webp" && rgba.some((v, i) => i % 4 === 3 && v < 255);
}
