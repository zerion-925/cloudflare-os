// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { AiChatAuthorInfo } from "@gadgets/workshop-shared/api";
import { ComposerModelSelector, type SelectedModel } from "./ComposerModelSelector";
import { getStoredSelectedModel, persistSelectedModel } from "../../../modelSelection";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const models: AiChatAuthorInfo[] = [
  { type: "agent", id: "claude-opus-5-5", name: "Claude Opus 5.5" },
];

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  localStorage.clear();
});

function renderTriggerLabel(selectedModel: SelectedModel): string {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(
    <ComposerModelSelector
      models={models}
      selectedModel={selectedModel}
      onModelChange={() => {}}
    />,
  ));
  return container.querySelector('[aria-label="Select model"]')!.textContent!;
}

describe("ComposerModelSelector", () => {
  it("defaults a fresh account to the managed model without replacing personal or No-agent selections", () => {
    const managed: AiChatAuthorInfo = { type: "agent", id: "managed:cliproxy:gpt-5.5", name: "Shared" };
    expect(getStoredSelectedModel([managed])).toBe(managed.id);
    persistSelectedModel(models[0].id);
    expect(getStoredSelectedModel([...models, managed])).toBe(models[0].id);
    persistSelectedModel(managed.id);
    expect(getStoredSelectedModel([...models, managed])).toBe(managed.id);
    persistSelectedModel(null);
    expect(getStoredSelectedModel([managed])).toBeNull();
    persistSelectedModel(managed.id);
    expect(getStoredSelectedModel([])).toBeNull();
  });

  it("labels an offered model by its listed name", () => {
    expect(renderTriggerLabel({ id: "claude-opus-5-5", name: "Stale name" })).toBe("Claude Opus 5.5");
  });

  // An existing chat can still be on a model the picker has since hidden.
  it("labels a model the list doesn't offer by the chat's own name for it", () => {
    expect(renderTriggerLabel({ id: "claude-opus-5", name: "Claude Opus 5" })).toBe("Claude Opus 5");
  });

  it("falls back to the raw id when no name is known", () => {
    expect(renderTriggerLabel({ id: "claude-opus-5" })).toBe("claude-opus-5");
  });
});
