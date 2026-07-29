import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { IndexProgressBanner } from "./App";

describe("IndexProgressBanner", () => {
  const progress = {
    status: "indexing" as const,
    phase: "scanning" as const,
    indexedItems: 12_345,
    completedRoots: 1,
    totalRoots: 2,
    currentRoot: "D:\\",
  };

  it("shows live indexing progress without blocking the workspace", () => {
    render(<IndexProgressBanner progress={progress} />);

    expect(screen.getByRole("status", { name: "后台索引进度" })).toBeInTheDocument();
    expect(screen.getByText(/D:\\.*12,345/)).toBeInTheDocument();
    expect(screen.getByText("1 / 2 个位置")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("can collapse to a compact status and expand again", async () => {
    const user = userEvent.setup();
    render(<IndexProgressBanner progress={progress} />);

    await user.click(screen.getByRole("button", { name: "隐藏索引详情" }));
    expect(screen.queryByText(/D:\\.*12,345/)).not.toBeInTheDocument();
    expect(screen.getByText("索引中")).toBeInTheDocument();
    expect(document.querySelector(".lucide-chevron-up")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "展开索引详情" }));
    expect(screen.getByText(/D:\\.*12,345/)).toBeInTheDocument();
  });

  it("labels the NTFS fast path without presenting it as a slow directory walk", () => {
    render(
      <IndexProgressBanner
        progress={{
          ...progress,
          phase: "mft",
          completedRoots: 0,
          currentRoot: "D:\\",
        }}
      />,
    );

    expect(screen.getByText(/NTFS.*快速索引/)).toBeInTheDocument();
    expect(screen.queryByText(/正在扫描第/)).not.toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(screen.getByText("持续读取中")).toBeInTheDocument();
  });

  it("shows why NTFS fast indexing fell back instead of silently looking slow", () => {
    render(
      <IndexProgressBanner
        progress={{
          ...progress,
          fallbackReason: "读取 D: 的 MFT 失败，系统错误 5",
        }}
      />,
    );

    expect(screen.getByText(/快速索引未生效.*系统错误 5/)).toBeInTheDocument();
  });

  it("labels database finalization instead of pretending to scan the drives again", () => {
    render(
      <IndexProgressBanner
        progress={{
          ...progress,
          phase: "finalizing",
          completedRoots: 2,
          totalRoots: 2,
          currentRoot: undefined,
        }}
      />,
    );

    expect(screen.getByText("正在整理搜索索引")).toBeInTheDocument();
    expect(screen.getByText("文件读取已完成，正在安全切换索引")).toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });
});
