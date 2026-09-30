import semver from "semver"
import path from "path"

const rootPkgPath = path.resolve(import.meta.dir, "../../../package.json")
const rootPkg = await Bun.file(rootPkgPath).json()
const expectedBunVersion = rootPkg.packageManager?.split("@")[1]

if (!expectedBunVersion) {
  throw new Error("packageManager field not found in root package.json")
}

// relax version requirement
const expectedBunVersionRange = `^${expectedBunVersion}`

if (!semver.satisfies(process.versions.bun, expectedBunVersionRange)) {
  throw new Error(`This script requires bun@${expectedBunVersionRange}, but you are using bun@${process.versions.bun}`)
}

const opencodePkg = await Bun.file(path.resolve(import.meta.dir, "../../opencode/package.json")).json()

const env = {
  OPENCODE_CHANNEL: process.env["OPENCODE_CHANNEL"],
  OPENCODE_VERSION: process.env["OPENCODE_VERSION"],
  OPENCODE_RELEASE: process.env["OPENCODE_RELEASE"],
}

const CHANNEL = env.OPENCODE_CHANNEL ?? "latest"

// The product's version lives in the package manifest (restarted at 0.1.0);
// a build may override it with OPENCODE_VERSION (e.g. the tag in release CI).
// No upstream registry lookups — the product does not derive identity from
// the upstream package.
const VERSION = env.OPENCODE_VERSION ?? (opencodePkg.version as string)

export const Script = {
  get channel() {
    return CHANNEL
  },
  get version() {
    return VERSION
  },
  get preview() {
    return CHANNEL !== "latest"
  },
  get release(): boolean {
    return !!env.OPENCODE_RELEASE
  },
}

console.log(`opencode script`, JSON.stringify(Script, null, 2))
