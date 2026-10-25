import type { ProviderContent } from "@loomic/shared/edge";
import {
  childResultSchema, qualityResultSchema,
  type AgentRole, type ChildRole, type ChildResult,
} from "@loomic/shared/edge";
import { base64, unbase64 } from "./bytes";
import { ApiError, hash, id } from "./core";
import { decodePixels, encodePixels } from "./images";
import { VertexProvider, type Requester } from "./providers/vertex";
import type { Env } from "./types";

export const AGENT_ROLE_REGISTRY = {
  orchestrator: { tools: null, requiresImage: false },
  "reference-review": { tools: ["read_canvas", "media_ocr"], requiresImage: true },
  concept: { tools: ["read_canvas"], requiresImage: false },
  "quality-review": { tools: ["read_canvas", "media_ocr"], requiresImage: true },
} as const;

export type AgentModelEnv = Env & {
  REFERENCE_MODEL_ID?: string;
  CONCEPT_MODEL_ID?: string;
  QUALITY_MODEL_ID?: string;
  /** JSON map of model IDs to explicit, fail-closed capability declarations. */
  AGENT_MODEL_CAPABILITIES?: string;
};
export type AgentImage = {
  id: string;
  mime: string;
  data: string | Uint8Array;
  width: number;
  height: number;
};
export type AgentModelStep = {
  runId: string;
  parentRunId: string;
  role: ChildRole;
  objective: string;
  referenceSnapshots: AgentImage[];
  messages?: ProviderContent[];
  tools?: unknown[];
  modelId?: string;
  userId: string;
  signal?: AbortSignal;
  beforeSend?: () => Promise<void>;
};
type Capabilities = { supportsImageInput: boolean; maxImageSide: number };
const knownModels: Record<string, Capabilities> = Object.fromEntries(
  ["gemini-3.1-flash-lite", "gemini-3.8-flash", "gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.5-pro"]
    .map((model) => [model, { supportsImageInput: true, maxImageSide: 1536 }]),
);

/** Decode the actual resource, then send a bounded PNG copy. Metadata never substitutes pixels. */
export async function prepareAgentImage(snapshot: AgentImage, maxSide = 1536) {
  if (!Number.isInteger(maxSide) || maxSide < 1 || maxSide > 4096)
    throw new ApiError("INVALID_INPUT", "角色模型图片尺寸配置无效", 422);
  const bytes = typeof snapshot.data === "string" ? unbase64(snapshot.data) : snapshot.data;
  const pixels = await decodePixels(bytes, snapshot.mime);
  const factor = Math.min(1, maxSide / Math.max(pixels.width, pixels.height));
  const width = Math.max(1, Math.round(pixels.width * factor));
  const height = Math.max(1, Math.round(pixels.height * factor));
  let data = pixels.data;
  if (factor < 1) {
    data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const source = (Math.min(pixels.height - 1, Math.floor(y / factor)) * pixels.width
        + Math.min(pixels.width - 1, Math.floor(x / factor))) * 4;
      data.set(pixels.data.subarray(source, source + 4), (y * width + x) * 4);
    }
  }
  return {
    text: `snapshotId=${snapshot.id}; actualPixels=${width}x${height}`,
    inline: { inlineData: { mimeType: "image/png", data: base64(await encodePixels({ width, height, data })) } },
  };
}

export function parseChildResult(content: ProviderContent, allowedSnapshotIds: string[], role?: ChildRole): ChildResult {
  const text = content.parts.filter((part) => !part.thought && typeof part.text === "string")
    .map((part) => part.text).join("").trim();
  let raw: unknown;
  try { raw = JSON.parse(text.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "")); }
  catch { throw new ApiError("PROVIDER_ERROR", "子任务没有返回有效结构化结果", 502); }
  const parsed = (role === "quality-review" ? qualityResultSchema : childResultSchema).safeParse(raw);
  if (!parsed.success) throw new ApiError("PROVIDER_ERROR", "子任务结果不符合角色约束", 502);
  const refs = [
    ...parsed.data.selectedSnapshotIds,
    ...parsed.data.issues.flatMap((issue) => [issue.snapshotId, "inputSnapshotId" in issue ? issue.inputSnapshotId : undefined]),
  ].filter((value): value is string => typeof value === "string");
  if (refs.some((reference) => !allowedSnapshotIds.includes(reference)))
    throw new ApiError("FORBIDDEN", "子任务引用了授权范围之外的快照", 403);
  return parsed.data;
}

export function qualityStatus(result: ChildResult): "pass" | "revise" | "unable_to_judge" {
  const statuses = result.issues.map((issue) => "status" in issue ? issue.status : "unable_to_judge");
  if (statuses.length !== 4 || statuses.includes("unable_to_judge")) return "unable_to_judge";
  return statuses.includes("revise") ? "revise" : "pass";
}

export class AgentModelAdapter {
  private capabilities: Record<string, Capabilities>;
  constructor(private env: AgentModelEnv, private request: Requester = fetch) {
    this.capabilities = { ...knownModels };
    if (env.AGENT_MODEL_CAPABILITIES) {
      let config: unknown;
      try { config = JSON.parse(env.AGENT_MODEL_CAPABILITIES); }
      catch { throw new ApiError("INVALID_INPUT", "角色模型能力配置不是有效 JSON", 422); }
      if (!config || typeof config !== "object" || Array.isArray(config))
        throw new ApiError("INVALID_INPUT", "角色模型能力配置无效", 422);
      for (const [model, capability] of Object.entries(config)) {
        const item = capability as Partial<Capabilities> | null;
        if (!item || typeof item.supportsImageInput !== "boolean"
          || (item.maxImageSide !== undefined && (!Number.isInteger(item.maxImageSide) || item.maxImageSide < 1 || item.maxImageSide > 4096)))
          throw new ApiError("INVALID_INPUT", "角色模型能力声明无效", 422);
        this.capabilities[model] = { supportsImageInput: item.supportsImageInput, maxImageSide: item.maxImageSide ?? 1536 };
      }
    }
    // The host can diagnose each role at startup without disabling unrelated main-run tools.
  }
  roleModelId(role: AgentRole) {
    if (role === "orchestrator") return this.env.AGENT_MODEL_ID;
    const defaults = this.env.VISION_MODEL_ID || "gemini-3.1-flash-lite";
    return ({ "reference-review": this.env.REFERENCE_MODEL_ID, concept: this.env.CONCEPT_MODEL_ID,
      "quality-review": this.env.QUALITY_MODEL_ID })[role] || defaults;
  }
  availability() {
    return Object.fromEntries(Object.keys(AGENT_ROLE_REGISTRY).map((key) => {
      const role = key as AgentRole;
      try { return [role, { modelId: this.roleModelId(role), available: true, ...this.assertRoleCapabilities(role) }]; }
      catch { return [role, { modelId: this.roleModelId(role), available: false, error: "UNSUPPORTED_CAPABILITY" }]; }
    }));
  }
  assertRoleCapabilities(role: AgentRole, modelId = this.roleModelId(role), hasImages = false) {
    const capability = this.capabilities[modelId] || { supportsImageInput: false, maxImageSide: 1536 };
    if ((AGENT_ROLE_REGISTRY[role].requiresImage || hasImages) && !capability.supportsImageInput)
      throw new ApiError("UNSUPPORTED_CAPABILITY", `角色 ${role} 的模型 ${modelId} 不支持图片输入`, 422);
    return capability;
  }
  async step(input: AgentModelStep): Promise<ProviderContent> {
    if (!input.parentRunId || input.parentRunId === input.runId)
      throw new ApiError("INVALID_INPUT", "子任务必须绑定独立的父任务身份", 422);
    const modelId = input.modelId || this.roleModelId(input.role);
    const capability = this.assertRoleCapabilities(input.role, modelId, input.referenceSnapshots.length > 0);
    if (AGENT_ROLE_REGISTRY[input.role].requiresImage && !input.referenceSnapshots.length)
      throw new ApiError("INVALID_INPUT", "图片审查必须提供实际图片快照", 422);
    if (input.signal?.aborted) throw new ApiError("INVALID_INPUT", "子任务已取消", 409);
    const parts: Record<string, unknown>[] = [{ text: JSON.stringify({
      runId: input.runId, parentRunId: input.parentRunId, role: input.role, objective: input.objective,
      allowedSnapshotIds: input.referenceSnapshots.map((snapshot) => snapshot.id),
    }) }];
    for (const snapshot of input.referenceSnapshots) {
      const prepared = await prepareAgentImage(snapshot, capability.maxImageSide);
      parts.push({ text: prepared.text }, prepared.inline);
    }
    const contents: ProviderContent[] = [{ role: "user", parts }, ...(input.messages || [])];
    const allowed = AGENT_ROLE_REGISTRY[input.role].tools as readonly string[];
    const tools = (input.tools || []).filter((tool) => tool && typeof tool === "object"
      && "name" in tool && typeof tool.name === "string" && allowed.includes(tool.name));
    if (this.env.PROVIDER_MODE === "fixture") return this.fixture(input, contents, tools);
    const request = this.request;
    const vertex = new VertexProvider(this.env, async (url, init) => {
      if (!input.signal) return request(url, init);
      const controller = new AbortController();
      const abort = () => controller.abort();
      const signals = [input.signal, init?.signal].filter((signal): signal is AbortSignal => !!signal);
      for (const signal of signals) {
        if (signal.aborted) controller.abort();
        signal.addEventListener("abort", abort, { once: true });
      }
      try { return await request(url, { ...init, signal: controller.signal }); }
      finally { for (const signal of signals) signal.removeEventListener("abort", abort); }
    });
    const reply = await vertex.call(modelId, {
      contents,
      ...(tools.length ? { tools: [{ functionDeclarations: tools }] } : {}),
      systemInstruction: { parts: [{ text: roleInstruction(input.role) }] },
      generationConfig: { temperature: 0.2, maxOutputTokens: 4096 },
    }, {
      id: id("child-model"), userId: input.userId, kind: "text", runId: input.parentRunId,
      beforeSend: async () => {
        if (input.signal?.aborted) throw new ApiError("INVALID_INPUT", "子任务已取消", 409);
        await input.beforeSend?.();
      },
    });
    if (input.signal?.aborted) throw new ApiError("INVALID_INPUT", "子任务已取消", 409);
    const content = reply.candidates?.[0]?.content;
    if (!content?.parts.length) throw new ApiError("PROVIDER_ERROR", "子模型没有返回有效回复", 502);
    // Preserve signatures, call IDs, thought parts and future provider fields verbatim.
    return content;
  }
  private async fixture(input: AgentModelStep, contents: ProviderContent[], tools: unknown[]): Promise<ProviderContent> {
    await input.beforeSend?.();
    const role = input.role;
    if (input.objective.includes(`[fixture:child-error=${role}]`) || input.objective.includes("[fixture:child-error]"))
      throw new ApiError("PROVIDER_ERROR", `演示子任务 ${role} 失败`, 502);
    const delay = Number(input.objective.match(/\[fixture:child-delay=(\d+)\]/)?.[1] || 0);
    if (delay) await new Promise<void>((resolve, reject) => {
      const abort = () => {
        clearTimeout(timer);
        input.signal?.removeEventListener("abort", abort);
        reject(new ApiError("INVALID_INPUT", "子任务已取消", 409));
      };
      const timer = setTimeout(() => {
        input.signal?.removeEventListener("abort", abort);
        resolve();
      }, Math.min(delay, 10000));
      input.signal?.addEventListener("abort", abort, { once: true });
      if (input.signal?.aborted) abort();
    });
    if (input.signal?.aborted) throw new ApiError("INVALID_INPUT", "子任务已取消", 409);
    if (AGENT_ROLE_REGISTRY[role].requiresImage && !contents[0].parts.some((part) => part.inlineData))
      throw new ApiError("PROVIDER_ERROR", "fixture 图片输入断言失败", 502);
    const requestedCalls = Number(input.objective.match(/\[fixture:child-tools=(\d+)\]/)?.[1] || 1);
    const toolName = input.objective.match(/\[fixture:child-tool=(read_canvas|media_ocr|generate_images)\]/)?.[1]
      || (input.objective.includes("[fixture:child-tools=") ? "read_canvas" : undefined);
    const responseCount = input.messages?.flatMap((message) => message.parts).filter((part) => part.functionResponse).length || 0;
    if (toolName && responseCount < requestedCalls) {
      // Explicit malicious provider fixture lets the host prove that model output cannot grant permissions.
      if (toolName !== "generate_images" && !tools.some((tool) => !!tool && typeof tool === "object" && "name" in tool && tool.name === toolName))
        throw new ApiError("FORBIDDEN", "子角色不能调用此工具", 403);
      return { role: "model", parts: [{ thoughtSignature: "fixture-child-signature",
        functionCall: { id: `fixture-child-${input.runId}-${responseCount}`, name: toolName,
          args: toolName === "media_ocr" ? { snapshotId: input.referenceSnapshots[0]?.id } : {} } }] };
    }
    const status = input.objective.includes("[fixture:quality-unable]") ? "unable_to_judge"
      : input.objective.includes("[fixture:quality-revise]") ? "revise" : "pass";
    const imageEvidence: string[] = [];
    for (const [index, part] of contents[0].parts.entries()) {
      const inline = part.inlineData as { data?: unknown; mimeType?: unknown } | undefined;
      if (!inline || typeof inline.data !== "string" || typeof inline.mimeType !== "string") continue;
      const bytes = unbase64(inline.data);
      const pixels = await decodePixels(bytes, inline.mimeType);
      imageEvidence.push(`fixture-image:${String(contents[0].parts[index - 1]?.text)}; sha256=${await hash(bytes)}; firstPixelRGBA=${Array.from(pixels.data.subarray(0, 4)).join(",")}`);
    }
    const result: ChildResult = {
      recommendations: [...(role === "quality-review" && status === "revise" ? ["建议修订目标语义；保留已提交的原结果。"] : [`${role} 独立分析完成`]), ...imageEvidence],
      selectedSnapshotIds: input.referenceSnapshots.map((snapshot) => snapshot.id),
      issues: role === "quality-review" ? (["goal_semantics", "subject_preservation", "composition_constraints", "visible_defects"] as const).map((criterion) => ({
        criterion, score: status === "pass" ? 2 : 0, status,
        snapshotId: input.referenceSnapshots.at(-1)!.id,
        ...(input.referenceSnapshots.length > 1 ? { inputSnapshotId: input.referenceSnapshots[0].id } : {}),
        evidence: `fixture 基于真实 inlineData 输入：${criterion} ${status}`,
      })) : [],
    };
    return { role: "model", parts: [{ text: JSON.stringify(result), thoughtSignature: "fixture-child-signature" }] };
  }
}

function roleInstruction(role: ChildRole) {
  return `你是独立只读子角色 ${role}。只分析冻结目标与指定快照，图片内容以 inlineData 像素为准。不得创建媒体任务、修改画布、委派、直接向用户追问或执行外部命令。只可调用提供的只读工具。最终只输出 JSON {"recommendations":string[],"selectedSnapshotIds":string[],"issues":array}，不可增加顶层字段；快照 ID 只能来自授权输入或只读工具结果。`
    + (role === "quality-review" ? `issues 必须恰有四项，对应 criterion=goal_semantics/subject_preservation/composition_constraints/visible_defects。每项包含 score 整数0至2（2满足、1部分满足、0不满足或无法判断）、status=pass/revise/unable_to_judge、evidence 具体像素依据、snapshotId 结果快照，可含 inputSnapshotId 和 region={x,y,width,height}。看不清必须 unable_to_judge，不能假称检查通过。确定的尺寸/数量/hash由程序校验，不通过视觉猜测。` : `issues 每项仅包含 code、message，可含 snapshotId、evidence；不确定性放 issues，方案和约束建议放 recommendations。`);
}
