// Platform-correct locations for Herdr's plugin config and state directories.
//
// At runtime Herdr injects the real paths (HERDR_PLUGIN_CONFIG_DIR /
// HERDR_PLUGIN_STATE_DIR) and everything should use those. These are only the
// fallback for running a script by hand, which is exactly where a
// Windows-shaped default silently produces a relative path on Linux or macOS
// and writes state to the wrong place — so resolve per platform properly.
//
// `resolveRoots` takes its platform/env/home explicitly rather than reading
// globals. node:path's separator and os.homedir() are both locked to the host
// OS, so the darwin/linux branches cannot be exercised from a Windows machine
// by faking process.platform; passing them in makes every branch testable
// anywhere, which is what .github/scripts/check-paths.mjs relies on.
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_PLUGIN_ID = "dingtalk-omo-bridge";

export function resolveRoots({ platform, env = {}, home }) {
  if (platform === "win32") {
    return {
      config: env.APPDATA ?? join(home, "AppData", "Roaming"),
      state: env.LOCALAPPDATA ?? join(home, "AppData", "Local"),
    };
  }
  if (platform === "darwin") {
    const appSupport = join(home, "Library", "Application Support");
    return { config: appSupport, state: appSupport };
  }
  return {
    config: env.XDG_CONFIG_HOME ?? join(home, ".config"),
    state: env.XDG_DATA_HOME ?? join(home, ".local", "share"),
  };
}

export function configDirFor(roots, pluginId = DEFAULT_PLUGIN_ID) {
  return join(roots.config, "herdr", "plugins", "config", pluginId);
}

export function stateDirFor(roots, pluginId = DEFAULT_PLUGIN_ID) {
  return join(roots.state, "herdr", "plugins", pluginId);
}

const ROOTS = resolveRoots({ platform: process.platform, env: process.env, home: homedir() });

export const defaultConfigDir = (pluginId = DEFAULT_PLUGIN_ID) => configDirFor(ROOTS, pluginId);
export const defaultStateDir = (pluginId = DEFAULT_PLUGIN_ID) => stateDirFor(ROOTS, pluginId);
