import { Maximize2, Minus, X } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";

async function performWindowAction(
  action: "minimize" | "toggleMaximize" | "close",
) {
  try {
    await getCurrentWindow()[action]();
  } catch (error) {
    console.error(`Atlas window action failed: ${action}`, error);
  }
}

export default function WindowChrome() {
  return (
    <header className="window-chrome" data-tauri-drag-region>
      <div className="window-chrome-title" data-tauri-drag-region>
        <span aria-hidden="true" />
        <strong data-tauri-drag-region>ATLAS</strong>
        <small data-tauri-drag-region>本地效率工作台</small>
      </div>
      <div className="window-chrome-controls" aria-label="窗口控制">
        <button
          type="button"
          aria-label="最小化"
          title="最小化"
          onClick={() => void performWindowAction("minimize")}
        >
          <Minus size={15} strokeWidth={1.8} />
        </button>
        <button
          type="button"
          aria-label="最大化或还原"
          title="最大化或还原"
          onClick={() => void performWindowAction("toggleMaximize")}
        >
          <Maximize2 size={13} strokeWidth={1.7} />
        </button>
        <button
          type="button"
          className="window-close"
          aria-label="关闭"
          title="关闭"
          onClick={() => void performWindowAction("close")}
        >
          <X size={15} strokeWidth={1.8} />
        </button>
      </div>
    </header>
  );
}
