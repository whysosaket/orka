import { createRoot } from "react-dom/client";
import { MotionConfig } from "motion/react";
import { App } from "./app.js";
import { DevelopmentTools } from "./components/development-tools.js";
import "@fontsource-variable/inter";
import "./style.css";

createRoot(document.getElementById("root")!).render(
  <MotionConfig reducedMotion="user">
    <DevelopmentTools>
      <App />
    </DevelopmentTools>
  </MotionConfig>,
);
