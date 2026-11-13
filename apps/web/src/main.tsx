import { AppearanceProvider, initializeAppearance } from "./ui/theme";
import { ConfirmationProvider } from "./ui/patterns/ConfirmationProvider";
import React, { lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";

const showWorkbench = import.meta.env.DEV && window.location.pathname === "/__design";

if (showWorkbench) {
  import("./shared/theme/v1.css");
  const WorkbenchV1 = lazy(() => import("./app/WorkbenchV1").then((m) => ({ default: m.WorkbenchV1 })));
  createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <Suspense fallback={<p>正在加载 v1.0 组件工作台…</p>}>
        <WorkbenchV1 />
      </Suspense>
    </React.StrictMode>
  );
} else {
  await import("./styles.css");
  await import("./workspace-chat-enhancements.css");
  const { App } = await import("./App");
  initializeAppearance();
  createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <AppearanceProvider>
        <ConfirmationProvider>
          <App />
        </ConfirmationProvider>
      </AppearanceProvider>
    </React.StrictMode>
  );
}
