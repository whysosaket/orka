import { createRoot } from "react-dom/client";
import { MotionConfig } from "motion/react";
import { App } from "./app.js";
import { DevelopmentTools } from "./components/development-tools.js";
import "@fontsource-variable/inter";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "./style.css";
import { MenuBar } from "./components/menu-bar.js";

const menuBar = new URLSearchParams(window.location.search).has("menu-bar");
if (menuBar) document.documentElement.classList.add("menu-bar-window");

createRoot(document.getElementById("root")!).render(
  <MotionConfig reducedMotion="user">
    {menuBar ? (
      <MenuBar />
    ) : (
      <DevelopmentTools>
        <App />
      </DevelopmentTools>
    )}
  </MotionConfig>,
);
