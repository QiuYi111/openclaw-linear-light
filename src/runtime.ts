/**
 * Plugin runtime store for Linear Light
 *
 * Holds the PluginRuntime reference and shared LinearAgentApi instance
 * so webhook handler and activity stream can access them.
 */

// @ts-expect-error — exported from local plugin-sdk but may not be in CI's version
import { createPluginRuntimeStore } from "openclaw/plugin-sdk"
import type { PluginRuntime } from "openclaw/plugin-sdk"
import type { LinearAgentApi } from "./api/linear-api.js"

export const { setRuntime: setLinearRuntime, getRuntime: getLinearRuntime } =
  createPluginRuntimeStore<PluginRuntime>("Linear runtime not initialized")

// Shared Linear API instance (set during plugin register)
let _linearApi: LinearAgentApi | null = null

export function setLinearApi(api: LinearAgentApi): void {
  _linearApi = api
}

export function getLinearApi(): LinearAgentApi | null {
  return _linearApi
}
