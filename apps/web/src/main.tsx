import { AppearanceProvider, initializeAppearance } from "./ui/theme";
import { ConfirmationProvider } from "./ui/patterns/ConfirmationProvider";
import React, { lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";
import "./workspace-chat-enhancements.css";

const Workbench = import.meta.env.DEV ? lazy(() => import("./ui/workbench/Workbench").then((module) => ({ default: module.Workbench }))) : null;
const showWorkbench = import.meta.env.DEV && window.location.pathname === "/__design";

initializeAppearance();

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AppearanceProvider><ConfirmationProvider>{showWorkbench && Workbench ? <Suspense fallback={<p>正在加载组件工作台…</p>}><Workbench /></Suspense> : <App />}</ConfirmationProvider></AppearanceProvider>
  </React.StrictMode>
);
