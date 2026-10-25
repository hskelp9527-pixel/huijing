import { Suspense } from "react";

import { WorkspaceView } from "../../components/workspace/workspace-view";

// 静态导出下不能用动态路由 /p/[id]，工作区地址为 /p?id=<projectId>&thread=<threadId>
export default function WorkspacePage() {
  return (
    <Suspense>
      <WorkspaceView />
    </Suspense>
  );
}
