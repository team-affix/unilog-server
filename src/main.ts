#!/usr/bin/env node
import os from 'os';
import path from 'path';
import { KuboAdmin } from './kubo-admin';
import { createServer } from './server';
import { VERSION } from './version';

/**
 * The Unilog server, configured by environment variables:
 *
 *   PORT, HOST     where to listen (default 3000, all interfaces)
 *   KUBO_API       the server's own Kubo node's HTTP API (default http://127.0.0.1:5001; keep it private)
 *   DATA_DIR       where pin requests are stored (default ~/.unilog-server)
 *   TOKENS         comma-separated access tokens; if set, adding pins needs one
 *   ANNOUNCE       comma-separated multiaddrs of the node, for clients to connect to (default: the node's own)
 *   KEEP_DEPS      1: keep each package's dependencies too, not only what was pushed
 */
const list = (v?: string) =>
    v
        ?.split(',')
        .map((s) => s.trim())
        .filter(Boolean);

async function main() {
    const port = Number(process.env.PORT ?? 3000);
    const host = process.env.HOST;
    const kubo = new KuboAdmin(process.env.KUBO_API ?? 'http://127.0.0.1:5001');
    const ipfs = await kubo.version();
    const tokens = list(process.env.TOKENS);
    const announce = list(process.env.ANNOUNCE);
    const server = await createServer({
        kubo,
        dataDir: process.env.DATA_DIR ?? path.join(os.homedir(), '.unilog-server'),
        ...(tokens && { tokens }),
        ...(announce && { delegates: announce }),
        keepDependencies: process.env.KEEP_DEPS === '1',
    });
    server.http.listen(port, host, () => {
        console.log(`unilog-server ${VERSION} listening on ${host ?? '*'}:${port}, using Kubo ${ipfs} at ${kubo.api}`);
        console.log('keeping packages that check with Unilog, for good (nothing is ever removed)');
        if (!tokens) console.log('anyone may push (set TOKENS to require a token)');
        console.log(`clients push here with: ipfs pin remote service add <name> http://<this host>:${port} <token>`);
        console.log('and fetch from here after peering their node with one of these addresses:');
        for (const a of server.delegates) console.log(`  ipfs swarm peering add ${a}`);
        console.log(
            process.env.KEEP_DEPS === '1'
                ? "keeping packages' dependencies too"
                : 'keeping only what was pushed (KEEP_DEPS=1 keeps dependencies too)',
        );
    });
}

main().catch((e: unknown) => {
    console.error((e as Error).message);
    process.exitCode = 1;
});
