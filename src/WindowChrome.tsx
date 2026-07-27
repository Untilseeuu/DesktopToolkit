import { Maximize2, Minus, X } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useState } from "react";

async function performWindowAction(
  action: "minimize" | "toggleMaximize" | "hide",
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
}: {
  title?: string;
  description?: string;
  confirmOnClose?: boolean;
  onDisableCloseReminder?: () => void;
}) {
  const [confirmingClose, setConfirmingClose] = useState(false);
  const [dontRemindAgain, setDontRemindAgain] = useState(false);
  const requestClose = useCallback(() => {
    if (confirmOnClose) {
      setDontRemindAgain(false);
      setConfirmingClose(true);
      return;
    }
    void performWindowAction("hide");
  }, [confirmOnClose]);
  useEffect(() => {
    let dispose: (() => void) | undefined;
    void import("@tauri-apps/api/event")
      .then(({ listen }) => listen("atlas-close-requested", requestClose))
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
            onClick={requestClose}
          >
            <X size={15} strokeWidth={1.8} />
          </button>
        </div>
      </header>
      {confirmingClose ? (
        <div className="modal-backdrop window-close-backdrop">
          <section
            className="confirm-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="window-close-title"
          >
            <span className="confirm-dialog-icon"><X size={20} /></span>
            <div>
              <h2 id="window-close-title">确认关闭 Atlas</h2>
              <p>关闭主窗口后，Atlas 会继续在系统托盘运行，快捷键和后台工具仍然有效。</p>
            </div>
            <label className="confirm-dialog-check">
              <input
                type="checkbox"
                checked={dontRemindAgain}
                onChange={(event) => setDontRemindAgain(event.target.checked)}
              />
              以后关闭时不再提醒
            </label>
            <footer>
              <button className="button ghost" onClick={() => setConfirmingClose(false)}>取消</button>
              <button
                className="button primary"
                onClick={() => {
                  if (dontRemindAgain) onDisableCloseReminder?.();
                  setConfirmingClose(false);
                  void performWindowAction("hide");
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
