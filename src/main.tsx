import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

const root = createRoot(document.getElementById("root")!);
const overlay = new URLSearchParams(window.location.search).get("overlay");

async function bootstrap() {
  if (overlay === "search" || overlay === "prompts" || overlay === "clipboard") {
    const { default: QuickOverlay } = await import("./QuickOverlay");
    root.render(
      <StrictMode>
        <QuickOverlay mode={overlay} />
      </StrictMode>,
    );
    return;
  }
  const { default: App } = await import("./App");
  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void bootstrap();
