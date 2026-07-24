import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ResultGlyph } from "./components";

describe("ResultGlyph", () => {
  it("shows a discovered application icon when one is available", () => {
    render(
      <ResultGlyph
        result={{
          id: "chatgpt",
          name: "ChatGPT",
          path: "shell:AppsFolder\\OpenAI.Codex!App",
          kind: "app",
          iconDataUrl: "data:image/png;base64,iVBORw==",
        }}
      />,
    );

    expect(screen.getByRole("img", { name: "ChatGPT" })).toHaveAttribute(
      "src",
      "data:image/png;base64,iVBORw==",
    );
  });
});
