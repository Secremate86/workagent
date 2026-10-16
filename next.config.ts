import type { NextConfig } from "next";
import "./scripts/workagent-sdk-hooks.mjs";
import { prepareWorkAgentPaths } from "./scripts/workagent-paths.mjs";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const configDir = dirname(fileURLToPath(import.meta.url));
const { agentDir } = prepareWorkAgentPaths(configDir);
if (!process.env.PI_CODING_AGENT_DIR) process.env.PI_CODING_AGENT_DIR = agentDir;
const { version } = JSON.parse(readFileSync(join(configDir, "package.json"), "utf8")) as { version: string };
let piVersion = "unknown";
try {
  const piPkgPath = join(configDir, "node_modules/@earendil-works/pi-coding-agent/package.json");
  piVersion = (JSON.parse(readFileSync(piPkgPath, "utf8")) as { version: string }).version;
} catch { /* package not found, use default */ }

// mdast-util-gfm-autolink-literal (remark-gfm) ships a RegExp lookbehind that
// Safari parses only from 16.4, which blanked `/` on iOS 16.2 (#753). The loader
// swaps it for an equivalent built at runtime; both bundlers must run it.
const gfmAutolinkEmailLoader = join(configDir, "lib/gfm-autolink-email-loader.cjs");

const nextConfig: NextConfig = {
  agentRules: false,
  devIndicators: false,
  outputFileTracingRoot: configDir,
  experimental: {
    webpackMemoryOptimizations: true,
    webpackBuildWorker: true,
    // proxy.ts matches /api/:path*, and Next buffers the request body whenever
    // a proxy is present, capped at 10 MB by default. The upload route accepts
    // up to 100 MB per request, so raise the buffer above that or large uploads
    // are truncated and fail with "Failed to parse body as FormData."
    proxyClientMaxBodySize: "128mb",
  },
  // next/image is only used for the static logo, so the /_next/image optimizer
  // (and its sharp/libheif attack surface, see GHSA-2xp9-vwfh-vxw4) is not needed.
  images: { unoptimized: true },
  // `next dev` runs Turbopack and `npm run build` runs webpack.
  turbopack: {
    rules: {
      "**/mdast-util-gfm-autolink-literal/lib/index.js": { loaders: [gfmAutolinkEmailLoader] },
    },
  },
  webpack(config, { isServer, webpack }) {
    // Docker builds do not reuse .next between source revisions. Avoid retaining
    // and serializing the large diagram/language graph after compilation.
    config.cache = false;
    if (process.env.WORKAGENT_BUILD_PROGRESS === "1") {
      let previous = -1;
      config.plugins.push(new webpack.ProgressPlugin((fraction: number, stage: string) => {
        const step = Math.floor(fraction * 20);
        if (step !== previous) {
          previous = step;
          console.log(`[WorkAgent ${isServer ? "server" : "client"}] ${Math.round(fraction * 100)}% ${stage}`);
        }
      }));
    }
    // Use the installed package's prebundled browser distribution, retaining
    // all diagrams and the transpilation required by supported browsers.
    config.resolve.alias["mermaid$"] = join(configDir, "node_modules/mermaid/dist/mermaid.esm.min.mjs");
    // These browser diagrams are loaded inside effects. Keep the Node SSR
    // compilation from duplicating Mermaid's complete diagram graph.
    // Client transpilation below remains enabled for supported browsers.
    if (isServer) config.externals.push({ mermaid: "commonjs mermaid" });
    config.module.rules.push({
      test: /[\\/]mdast-util-gfm-autolink-literal[\\/]lib[\\/]index\.js$/,
      loader: gfmAutolinkEmailLoader,
    });
    return config;
  },
  // Node modules keep the syntax they ship unless listed here, and mermaid's
  // lazy diagram chunks are full of class `static {}` blocks (#753).
  transpilePackages: ["mermaid", "@mermaid-js/parser"],
  serverExternalPackages: [
    "react-syntax-highlighter",
    "jiti",
    "pi-memory",
    "pi-routines",
    "node-pty",
    "undici",
    "web-push",
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-agent-core",
    "@earendil-works/pi-ai",
    "@earendil-works/pi-tui",
  ],
  // Next 16 blocks cross-origin access to dev resources by default. Allow the
  // loopback and the RFC1918 LAN ranges so the dev server stays reachable
  // from other machines on the same LAN.
  allowedDevOrigins: [
    "127.0.0.1",
    "10.*.*.*",
    // 172.16.0.0/12
    "172.16.*.*",
    "172.17.*.*",
    "172.18.*.*",
    "172.19.*.*",
    "172.20.*.*",
    "172.21.*.*",
    "172.22.*.*",
    "172.23.*.*",
    "172.24.*.*",
    "172.25.*.*",
    "172.26.*.*",
    "172.27.*.*",
    "172.28.*.*",
    "172.29.*.*",
    "172.30.*.*",
    "172.31.*.*",
    "192.168.*.*",
  ],
  async headers() {
    return [
      {
        source: "/",
        headers: [
          { key: "Cache-Control", value: "private, no-cache, max-age=0, must-revalidate" },
        ],
      },
      {
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "public, max-age=0, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
      {
        source: "/manifest.webmanifest",
        headers: [
          { key: "Cache-Control", value: "public, max-age=0, must-revalidate" },
        ],
      },
    ];
  },
  env: {
    NEXT_PUBLIC_APP_VERSION: version,
    NEXT_PUBLIC_PI_VERSION: piVersion,
  },
};

export default nextConfig;
