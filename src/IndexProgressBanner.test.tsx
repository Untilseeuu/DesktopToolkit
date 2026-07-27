import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { IndexProgressBanner } from "./App";

describe("IndexProgressBanner", () => {
  it("shows the current root, indexed item count and root progress", () => {
    render(
      <IndexProgressBanner
        progress={{
          status: "indexing",
          phase: "scanning",
          indexedItems: 12_345,
          completedRoots: 1,
          totalRoots: 2,
          currentRoot: "D:\\",
        }}
      />,
    );

    expect(screen.getByRole("progressbar", { name: "全盘索引进度" })).toHaveValue(1);
    expect(screen.getByText(/D:\\.*12,345/)).toBeInTheDocument();
    expect(screen.getByText("1 / 2 个位置")).toBeInTheDocument();
  });

  it("can collapse to a compact status and expand again", async () => {
    const user = userEvent.setup();
    render(
      <IndexProgressBanner
        progress={{
          status: "indexing",
          phase: "scanning",
          indexedItems: 12_345,
          completedRoots: 1,
          totalRoots: 2,
          currentRoot: "D:\\",
        }}
      />,
    );

    await user.click(screen.getByRole("button", { name: "隐藏索引详情" }));
    expect(screen.queryByText(/D:\\.*12,345/)).not.toBeInTheDocument();
    expect(screen.getByText("索引中")).toBeInTheDocument();
    expect(document.querySelector(".lucide-chevron-up")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "展开索引详情" }));
    expect(screen.getByText(/D:\\.*12,345/)).toBeInTheDocument();
  });

  it("shows active indeterminate progress while scanning the first large drive", () => {
    render(
      <IndexProgressBanner
        progress={{
          status: "indexing",
          phase: "scanning",
          indexedItems: 6_791,
          completedRoots: 0,
          totalRoots: 2,
          currentRoot: "C:\\",
        }}
      />,
    );

    expect(screen.getByRole("progressbar", { name: "全盘索引进度" })).not.toHaveAttribute("value");
    expect(screen.getByText("正在扫描第 1 / 2 个位置")).toBeInTheDocument();
  });
});
