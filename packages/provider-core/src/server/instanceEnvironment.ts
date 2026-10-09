import type { ProviderInstanceEnvironment } from "@t3tools/contracts";

import { stripAppImageRuntimeEnv } from "./appImageRuntimeEnv.ts";
import { expandHomePath } from "./pathExpansion.ts";

export function mergeProviderInstanceEnvironment(
  environment: ProviderInstanceEnvironment | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  // Agents and the shells they start get the user's environment, not the
  // AppImage runtime's. The packaged server runs as Electron-as-Node; an agent
  // that inherits that flag starts Node when it re-executes the app binary.
  // Spawns that need it set it explicitly.
  const next: NodeJS.ProcessEnv = { ...stripAppImageRuntimeEnv(baseEnv) };
  delete next.ELECTRON_RUN_AS_NODE;
  for (const variable of environment ?? []) {
    // Child processes do not apply shell expansion to environment values.
    next[variable.name] =
      variable.name === "CODEX_HOME" || variable.name === "CLAUDE_CONFIG_DIR"
        ? expandHomePath(variable.value)
        : variable.value;
  }
  return next;
}
