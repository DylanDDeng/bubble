import { describe, expect, it } from "vitest";
import { buildComposerSlashCommands, ComposerAutocompleteProvider } from "../tui/composer-autocomplete.js";

describe("pi-tui composer autocomplete", () => {
  it("orders renderer-local, builtin, skill, and MCP commands without shadowing executable names", () => {
    const commands = buildComposerSlashCommands(
      [
        { name: "help", description: "Show help", source: "builtin", handler: async () => {} },
        { name: "deploy", description: "Deploy prompt", source: "mcp", sourceLabel: "ops", handler: async () => {} },
      ],
      [
        { name: "podcast", description: "Create a podcast", source: "project" },
        { name: "help", description: "Must not shadow builtin", source: "project" },
      ],
    );

    expect(commands.map((command) => command.name)).toEqual(["fullscreen", "help", "podcast", "deploy"]);
    expect(commands.find((command) => command.name === "podcast")?.description).toContain("[skill · project]");
    expect(commands.find((command) => command.name === "deploy")?.description).toContain("[mcp:ops]");
  });

  it("reads dynamic command sources for every completion request", async () => {
    let includeMcp = false;
    const provider = new ComposerAutocompleteProvider({
      cwd: process.cwd(),
      commands: () => [
        { name: "help", description: "Show help", source: "builtin", handler: async () => {} },
        ...(includeMcp
          ? [{ name: "deploy", description: "Deploy prompt", source: "mcp" as const, handler: async () => {} }]
          : []),
      ],
      skills: () => [],
    });

    const first = await provider.getSuggestions(["/dep"], 0, 4, { signal: new AbortController().signal });
    expect(first).toBeNull();

    includeMcp = true;
    const second = await provider.getSuggestions(["/dep"], 0, 4, { signal: new AbortController().signal });
    expect(second?.items.map((item) => item.value)).toEqual(["deploy"]);
  });

  it("does not suggest a fullscreen transition when fullscreen is already the root renderer", () => {
    const commands = buildComposerSlashCommands(
      [{ name: "help", description: "Show help", source: "builtin", handler: async () => {} }],
      [],
      "fullscreen",
    );

    expect(commands.map((command) => command.name)).toEqual(["help"]);
  });
});
