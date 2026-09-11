import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AppearanceProvider, initializeAppearance } from "../theme";
import { Workbench } from "./Workbench";
import "../../styles.css";

initializeAppearance();
const root = document.getElementById("root");
if (root) createRoot(root).render(<StrictMode><AppearanceProvider><Workbench /></AppearanceProvider></StrictMode>);
