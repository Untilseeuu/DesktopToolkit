import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SearchFilterControls } from "./SearchFilterControls";

vi.mock("./native", () => ({
  listSearchDrives: vi.fn(async () => ["C:", "D:"]),
}));

describe("SearchFilterControls", () => {
  it("lists only disks that exist on the current computer", async () => {
    render(
      <SearchFilterControls
        className="filters"
        filters={{ kind: "all", extension: "", drive: "" }}
        onChange={() => undefined}
      />,
    );

    const drive = await screen.findByRole("combobox", { name: "所在磁盘" });
    const options = [...drive.querySelectorAll("option")].map((option) => option.value);
    expect(options).toEqual(["", "C:", "D:"]);
  });
});
