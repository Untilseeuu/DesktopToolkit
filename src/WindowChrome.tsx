import { Maximize2, Minus, X } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useState } from "react";
import { getSearchIndexProgress, quitApplication } from "./native";

async function performWindowAction(
  action: "minimize" | "toggleMaximize",
) {
  try {
    await getCurrentWindow()[action]();
  } catch (error) {
    console.error(`Atlas window action failed: ${action}`, error);
  }
}

export default function WindowChrome({
  title = "ATLAS",
  description = "本地效率工作台",
  confirmOnClose = false,
  onDisableCloseReminder,
  onBeforeQuit,
}: {
  title?: string;
  description?: string;
  confirmOnClose?: boolean;
  onDisableCloseReminder?: () => void;
  onBeforeQuit?: (disableReminder: boolean) => Promise<void>;
}) {
  const [closeReason, setCloseReason] = useState<"normal" | "indexing" | null>(null);
  const [dontRemindAgain, setDontRemindAgain] = useState(false);
  const quit = useCallback(async (disableReminder: boolean) => {
    if (disableReminder) onDisableCloseReminder?.();
    try {
      await onBeforeQuit?.(disableReminder);
    } finally {
      await quitApplication();
    }
  }, [onBeforeQuit, onDisableCloseReminder]);
  const requestClose = useCallback(async () => {
    const progress = await getSearchIndexProgress().catch(() => null);
    if (progress?.status === "indexing") {
      setDontRemindAgain(false);
      setCloseReason("indexing");
      return;
    }
    if (confirmOnClose) {
      setDontRemindAgain(false);
      setCloseReason("normal");
      return;
    }
    void quit(false);
  }, [confirmOnClose, quit]);
  useEffect(() => {
    let dispose: (() => void) | undefined;
    void import("@tauri-apps/api/event")
      .then(({ listen }) => listen("atlas-close-requested", () => void requestClose()))
      .then((unlisten) => {
        dispose = unlisten;
      })
      .catch(() => undefined);
    return () => dispose?.();
  }, [requestClose]);
  return (
    <>
      <header className="window-chrome" data-tauri-drag-region>
        <div className="window-chrome-title" data-tauri-drag-region>
          <span aria-hidden="true" />
          <strong data-tauri-drag-region>{title}</strong>
          <small data-tauri-drag-region>{description}</small>
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
            onClick={() => void requestClose()}
          >
            <X size={15} strokeWidth={1.8} />
          </button>
        </div>
      </header>
      {closeReason ? (
        <div className="modal-backdrop window-close-backdrop">
          <section
            className="confirm-dialog window-close-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="window-close-title"
          >
            <span className="confirm-dialog-icon"><X size={20} /></span>
            <div className="confirm-dialog-copy">
              <h2 id="window-close-title">
                {closeReason === "indexing" ? "索引正在建立" : "确认关闭 Atlas"}
              </h2>
              <p>
                {closeReason === "indexing"
                  ? "当前正在建立搜索索引。已完成的磁盘会保留，当前磁盘将在下次启动时继续处理。仍要关闭吗？"
                  : "退出后快捷键和后台工具会停止。"}
              </p>
            </div>
            {closeReason === "normal" ? <label className="confirm-dialog-check">
              <input
                type="checkbox"
                checked={dontRemindAgain}
                onChange={(event) => setDontRemindAgain(event.target.checked)}
              />
              以后关闭时不再提醒
            </label> : null}
            <footer>
              <button className="button ghost" onClick={() => setCloseReason(null)}>取消</button>
              <button
                className="button primary"
                onClick={() => {
                  const disableReminder = closeReason === "normal" && dontRemindAgain;
                  setCloseReason(null);
                  void quit(disableReminder);
                }}
              >
                确认关闭
              </button>
            </footer>
          </section>
        </div>
      ) : null}
    </>
  );
}
