import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import { mergeProviderInstanceEnvironment } from "./instanceEnvironment.ts";

describe("mergeProviderInstanceEnvironment", () => {
  it.effect.each([
    { value: "~/.account", tail: ".account" },
    { value: "~\\.account\\work", tail: ".account\\work" },
  ])("expands configured provider homes set to $value", ({ value, tail }) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const baseEnv = {
        CODEX_HOME: "~/.inherited-codex",
        CLAUDE_CONFIG_DIR: "~/.inherited-claude",
      };
      const environment = mergeProviderInstanceEnvironment(
        [
          { name: "CODEX_HOME", value, sensitive: false },
          { name: "CLAUDE_CONFIG_DIR", value, sensitive: false },
          { name: "CUSTOM_VALUE", value, sensitive: false },
        ],
        baseEnv,
      );

      expect(environment).toEqual({
        CODEX_HOME: path.join(NodeOS.homedir(), tail),
        CLAUDE_CONFIG_DIR: path.join(NodeOS.homedir(), tail),
        CUSTOM_VALUE: value,
      });
      expect(baseEnv).toEqual({
        CODEX_HOME: "~/.inherited-codex",
        CLAUDE_CONFIG_DIR: "~/.inherited-claude",
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it("leaves inherited provider homes unchanged", () => {
    const baseEnv = { CODEX_HOME: "~/.codex", CLAUDE_CONFIG_DIR: "~\\.claude" };

    expect(
      mergeProviderInstanceEnvironment(
        [{ name: "CUSTOM_VALUE", value: "~/.custom", sensitive: false }],
        baseEnv,
      ),
    ).toEqual({ ...baseEnv, CUSTOM_VALUE: "~/.custom" });
  });

  it("overrides inherited environment values and preserves empty strings", () => {
    expect(
      mergeProviderInstanceEnvironment(
        [
          { name: "OPENROUTER_API_KEY", value: "sk-or-test", sensitive: true },
          { name: "ANTHROPIC_API_KEY", value: "", sensitive: false },
        ],
        { ANTHROPIC_API_KEY: "inherited", PATH: "/bin" },
      ),
    ).toMatchObject({
      OPENROUTER_API_KEY: "sk-or-test",
      ANTHROPIC_API_KEY: "",
      PATH: "/bin",
    });
  });

  it("keeps the AppImage runtime and the Electron-as-Node flag out of agent sessions", () => {
    const appDir = "/tmp/.mount_T3-Codeabc123";

    expect(
      mergeProviderInstanceEnvironment(undefined, {
        APPIMAGE: "/home/user/T3-Code.AppImage",
        APPDIR: appDir,
        ARGV0: "/home/user/T3-Code.AppImage",
        OWD: "/home/user/project",
        ELECTRON_RUN_AS_NODE: "1",
        PATH: `${appDir}:${appDir}/usr/sbin:/usr/local/bin:/usr/bin`,
        LD_LIBRARY_PATH: `${appDir}/usr/lib`,
        HOME: "/home/user",
      }),
    ).toEqual({ PATH: "/usr/local/bin:/usr/bin", HOME: "/home/user" });
  });

  it("drops only the Electron-as-Node flag outside an AppImage", () => {
    expect(
      mergeProviderInstanceEnvironment([], {
        ELECTRON_RUN_AS_NODE: "1",
        OWD: "/home/user/keep-this",
        PATH: "/usr/bin",
      }),
    ).toEqual({ OWD: "/home/user/keep-this", PATH: "/usr/bin" });
  });

  it("applies provider settings after the scrub", () => {
    expect(
      mergeProviderInstanceEnvironment(
        [
          { name: "ELECTRON_RUN_AS_NODE", value: "1", sensitive: false },
          { name: "APPDIR", value: "/opt/configured", sensitive: false },
        ],
        { APPIMAGE: "/home/user/T3-Code.AppImage", APPDIR: "/tmp/.mount_T3-x", PATH: "/usr/bin" },
      ),
    ).toEqual({ ELECTRON_RUN_AS_NODE: "1", APPDIR: "/opt/configured", PATH: "/usr/bin" });
  });
});
