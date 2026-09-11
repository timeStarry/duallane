import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ConfirmationProvider, useConfirmation } from "./ConfirmationProvider";
import { initializeAppearance } from "../theme";
import "../../styles.css";

function Harness() {
  const { confirm, choose, cancelPending } = useConfirmation();
  const [result, setResult] = useState("idle");
  useEffect(() => {
    window.addEventListener("test:session-ended", cancelPending);
    return () => window.removeEventListener("test:session-ended", cancelPending);
  }, [cancelPending]);
  return <main><h1>命令确认回归</h1>
    <button onClick={async () => setResult(await confirm("移除指定对象？") ? "mutated" : "cancelled")}>移除对象</button>
    <button onClick={async () => setResult(await choose({ title: "删除合集", message: "选择处理方式", alternativeLabel: "仅删除合集" }))}>删除合集</button>
    <output role="status">{result}</output>
  </main>;
}

initializeAppearance();
createRoot(document.getElementById("root")!).render(<StrictMode><ConfirmationProvider><Harness /></ConfirmationProvider></StrictMode>);
