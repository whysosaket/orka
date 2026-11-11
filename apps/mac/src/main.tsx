import { createRoot } from "react-dom/client";
import { MotionConfig } from "motion/react";
import { App } from "./app.js";
import { DevelopmentTools } from "./components/development-tools.js";
import "@fontsource-variable/inter";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "./style.css";

createRoot(document.getElementById("root")!).render(
  <MotionConfig reducedMotion="user">
    <DevelopmentTools>
      <App />
    </DevelopmentTools>
  </MotionConfig>,
);
