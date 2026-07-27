import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SearchQueryInput } from "./SearchQueryInput";

describe("SearchQueryInput", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps typing local and coalesces expensive parent searches", () => {
    vi.useFakeTimers();
    const onSearchChange = vi.fn();
    render(
      <SearchQueryInput
        onSearchChange={onSearchChange}
        placeholder="Search"
      />,
    );
    const input = screen.getByPlaceholderText("Search");

    fireEvent.change(input, { target: { value: "e" } });
    fireEvent.change(input, { target: { value: "ev" } });
    fireEvent.change(input, { target: { value: "eve" } });

    expect(input).toHaveValue("eve");
    expect(onSearchChange).not.toHaveBeenCalled();
    vi.advanceTimersByTime(80);
    expect(onSearchChange).toHaveBeenCalledTimes(1);
    expect(onSearchChange).toHaveBeenLastCalledWith("eve");
  });

  it("flushes the current text immediately when submitted", () => {
    vi.useFakeTimers();
    const onSearchChange = vi.fn();
    const onSubmit = vi.fn();
    render(
      <SearchQueryInput
        onSearchChange={onSearchChange}
        onSubmit={onSubmit}
        placeholder="Search"
      />,
    );
    const input = screen.getByPlaceholderText("Search");
    fireEvent.change(input, { target: { value: "atlas" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onSearchChange).toHaveBeenLastCalledWith("atlas");
    expect(onSubmit).toHaveBeenCalledWith("atlas");
    vi.advanceTimersByTime(100);
    expect(onSearchChange).toHaveBeenCalledTimes(1);
  });
});
