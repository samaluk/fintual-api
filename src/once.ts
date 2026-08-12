import { pathToFileURL } from "node:url"

import { NodeRuntime } from "@effect/platform-node"

import { mainOnce } from "./main.ts"

function isMainModule(): boolean {
  return import.meta.url === pathToFileURL(process.argv[1] ?? "").href
}

if (isMainModule()) {
  NodeRuntime.runMain(mainOnce(), { disableErrorReporting: true })
}
