/**
 * Plugin runtime store for Linear Light
 *
 * Holds the PluginRuntime reference so the webhook handler can access
 * channel utilities (routing, session, reply dispatch).
 */

import { createPluginRuntimeStore } from "openclaw/plugin-sdk"
import type { PluginRuntime } from "openclaw/plugin-sdk"

export const { setRuntime: setLinearRuntime, getRuntime: getLinearRuntime } =
  createPluginRuntimeStore<PluginRuntime>("Linear runtime not initialized")
