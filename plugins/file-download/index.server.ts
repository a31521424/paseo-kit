import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import { createTransferStore } from "./server/transfers";
import { closeRpc, hostRpc, openRpc, readRpc } from "./shared/download";

type Paseo = PluginHandlerContext["paseo"];

/** The daemon keeps its server ID in $PASEO_HOME/server-id unless PASEO_SERVER_ID overrides it. */
async function readServerId(): Promise<string | null> {
  if (process.env.PASEO_SERVER_ID) return process.env.PASEO_SERVER_ID;
  const home = process.env.PASEO_HOME ?? path.join(os.homedir(), ".paseo");
  const id = await fs.readFile(path.join(home, "server-id"), "utf8").catch(() => "");
  return id.trim() || null;
}

async function resolveTabPath(paseo: Paseo, workspaceId: string, tabPath: string): Promise<string> {
  if (tabPath === "~" || tabPath.startsWith("~/")) return path.join(os.homedir(), tabPath.slice(1));
  if (path.isAbsolute(tabPath)) return path.normalize(tabPath);
  const workspace = (await paseo.workspaces.list({ page: { limit: 200 } })).entries.find((entry) => entry.id === workspaceId);
  const root = workspace?.workspaceDirectory ?? workspace?.projectRootPath;
  if (!root) throw new Error("This workspace is not open on the daemon.");
  return path.resolve(root, tabPath);
}

export default function contribute(server: PluginServerContext) {
  const transfers = createTransferStore();

  server.handle(hostRpc, async () => ({ serverId: await readServerId() }));
  // Any absolute path the app asks for: the same files Paseo's own preview can already read.
  server.handle(openRpc, async ({ workspaceId, path: tabPath }, { paseo }) =>
    transfers.open(await resolveTabPath(paseo, workspaceId, tabPath)),
  );
  server.handle(readRpc, ({ transferId, offset }) => transfers.read(transferId, offset));
  server.handle(closeRpc, ({ transferId }) => {
    transfers.close(transferId);
    return {};
  });

  return () => transfers.dispose();
}
