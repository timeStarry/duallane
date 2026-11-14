import React, { lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { AppV1 } from "./app/AppV1";
import { initializeV1Theme } from "./shared/theme/vibrancy";
import { ErrorBoundary } from "./shared/ui";
import "./shared/theme/v1.css";

initializeV1Theme();

const showWorkbench = import.meta.env.DEV && window.location.pathname === "/__design";

if (showWorkbench) {
  const WorkbenchV1 = lazy(() =>
    import("./app/WorkbenchV1").then((m) => ({ default: m.WorkbenchV1 }))
  );
  createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <ErrorBoundary>
        <Suspense fallback={<p>正在加载 v1.0 组件工作台…</p>}>
          <WorkbenchV1 />
        </Suspense>
      </ErrorBoundary>
    </React.StrictMode>
  );
} else {
  createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <ErrorBoundary>
        <AppV1 />
      </ErrorBoundary>
    </React.StrictMode>
  );
}
