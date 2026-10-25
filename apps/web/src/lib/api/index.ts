import type { ApiClient, ApiMode } from "./client";
import { FixtureApiClient } from "./fixture";
import { HttpApiClient } from "./http";

export type { ApiClient, ApiMode, Me, SnapshotResult } from "./client";
export * from "./contract";

/** NEXT_PUBLIC_API_MODE=fixture|http；构建时内联。 */
export const API_MODE: ApiMode =
  process.env.NEXT_PUBLIC_API_MODE === "fixture" ? "fixture" : "http";

let client: ApiClient | undefined;
export function getApi(): ApiClient {
  client ??=
    API_MODE === "fixture" ? new FixtureApiClient() : new HttpApiClient();
  // 演示模式下暴露给浏览器控制台，方便手工验证
  if (API_MODE === "fixture" && typeof window !== "undefined")
    (window as unknown as { __api?: ApiClient }).__api = client;
  return client;
}
