#!/usr/bin/env node
import os from 'os';
import path from 'path';
import { KuboAdmin } from './kubo-admin';
import { createServer } from './server';
import { HELP, parseArgs, startupMessages } from './startup';
import { VERSION } from './version';

/** The `unilog-server` command. It is configured by environment variables: see HELP in startup.ts. */
const list = (v?: string) =>
    v
        ?.split(',')
        .map((s) => s.trim())
        .filter(Boolean);

async function main() {
    const mode = parseArgs(process.argv.slice(2));
    if (mode === 'help') return void process.stdout.write(HELP);
    if (mode === 'version') return void console.log(VERSION);

    const port = Number(process.env.PORT ?? 3000);
    const host = process.env.HOST;
    const kubo = new KuboAdmin(process.env.KUBO_API ?? 'http://127.0.0.1:5001');
    const kuboVersion = await kubo.version();
    const tokens = list(process.env.TOKENS);
    const announce = list(process.env.ANNOUNCE);
    const keepDependencies = process.env.KEEP_DEPS === '1';
    const server = await createServer({
        kubo,
        dataDir: process.env.DATA_DIR ?? path.join(os.homedir(), '.unilog-server'),
        ...(tokens && { tokens }),
        ...(announce && { delegates: announce }),
        keepDependencies,
    });
    server.http.listen(port, host, () => {
        const { warnings, lines } = startupMessages({
            version: VERSION,
            port,
            ...(host && { host }),
            kuboVersion,
            kuboApi: kubo.api,
            kuboApiSet: process.env.KUBO_API !== undefined,
            tokens: !!tokens,
            ...(announce && { announced: announce }),
            nodeAddresses: server.delegates,
            keepDependencies,
        });
        for (const w of warnings) console.warn(`WARNING: ${w}`);
        for (const l of lines) console.log(l);
    });
}

main().catch((e: unknown) => {
    console.error((e as Error).message);
    process.exitCode = 1;
});
