import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { fetchTree, Graph, isCid, Kubo } from '@team-affix/dpm';
import { unilogCheck } from './check';
import { KuboAdmin } from './kubo-admin';
import { Pin, PinState, PinStatus } from './pinning';

/**
 * A Unilog server: the IPFS Pinning Service API in front of a Kubo node, keeping only packages that check with
 * Unilog.
 *
 * A client asks it to pin a CID and says where to fetch it (`origins`), e.g. with Kubo's `ipfs pin remote add`.
 * The server's Kubo fetches the package and everything it depends on (following each package's `dpm.json`) over
 * IPFS, hash-checked block by block, without pinning. Then Unilog checks it: if it passes, the server pins it;
 * if not, it reports the request failed, with Unilog's errors as the reason, and deletes what it fetched.
 * Content never travels over this API.
 *
 * What it keeps, it keeps for good: removing a request (`DELETE /pins/:requestid`) is not supported, so a package
 * others build on can't disappear from it.
 *
 * The Kubo node's RPC API is the server's private admin interface; only this server talks to it. Peers reach
 * the node through its own peer-to-peer port.
 */

/** Decides whether to keep a package, once it and its dependencies are fetched. Returns a reason to refuse it. */
export type Check = (pkg: { cid: string; graph: Graph; kubo: Kubo }) => Promise<string | undefined>;

export interface ServerOptions {
    kubo: KuboAdmin;
    /** Where pin requests are stored. */
    dataDir: string;
    /** If set, adding pins needs `Authorization: Bearer <one of these>`. Reading is open. */
    tokens?: readonly string[];
    /** Multiaddrs clients should connect to (default: the Kubo node's own addresses). */
    delegates?: readonly string[];
    /** How packages are checked (default: Unilog, see `unilogCheck`). Replaceable for tests. */
    check?: Check;
    /**
     * Pin each package's dependencies too, so everything listed can be installed from this server alone
     * (default: false). Either way, the whole tree is fetched (not pinned) and checked. Without
     * this, only what was asked for is pinned: a dependency is kept only if it was pushed itself
     * (each CID `dpm tree <cid>` prints, pushed with `ipfs pin remote add`).
     * Fetched data that isn't pinned is like any data a Kubo node downloads: kept until garbage collection.
     */
    keepDependencies?: boolean;
}

/** A pin request as stored: its public status, and the CIDs it holds once pinned (it, and its dependencies if kept). */
interface Request extends PinStatus {
    tree?: string[];
}

export interface UnilogServer {
    readonly http: http.Server;
    /** The node's addresses, for clients to connect (peer) their nodes to, so they can fetch from it. */
    readonly delegates: readonly string[];
    /** Resolves once every request queued so far has been processed (for tests and shutdown). */
    idle(): Promise<void>;
}

export async function createServer(opts: ServerOptions): Promise<UnilogServer> {
    const { kubo } = opts;
    const delegates = [...(opts.delegates ?? (await kubo.id()).addresses)];
    fs.mkdirSync(opts.dataDir, { recursive: true });
    const file = path.join(opts.dataDir, 'requests.json');
    const requests: Request[] = fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as Request[]) : [];
    const save = () => fs.writeFileSync(file, JSON.stringify(requests, null, 2));
    const publicStatus = (r: Request): PinStatus => {
        const { tree, ...status } = r;
        void tree; // internal: which CIDs this request holds
        return { ...status, delegates };
    };

    // One task at a time, in order: processing requests, and collecting garbage (which must not run while a
    // request is fetching). Requests interrupted by a restart are picked up again.
    let queue = Promise.resolve();
    const run = (task: () => Promise<void>) => {
        queue = queue.then(task).catch(() => undefined);
    };
    const enqueue = (r: Request) => run(() => processRequest(r));
    /** Deletes whatever the node doesn't pin, so it stops serving packages it refused. */
    const collect = () => run(() => kubo.gc());
    for (const r of requests) if (r.status === 'queued' || r.status === 'pinning') enqueue(r);

    /**
     * Unpins whatever of `cids` no pinned request holds: used only to undo a half-finished pinning after an error
     * from Kubo. A server should have a Kubo node of its own: a pin can't say who else relies on it.
     */
    async function release(cids: readonly string[]) {
        const keep = new Set(requests.filter((r) => r.status === 'pinned').flatMap((r) => r.tree ?? []));
        for (const cid of cids) if (!keep.has(cid)) await kubo.unpin(cid).catch(() => undefined);
    }

    async function processRequest(r: Request) {
        r.status = 'pinning';
        save();
        const pinned: string[] = [];
        try {
            // Connect to where the client said the content is. Failures are fine: the client also connects to us.
            for (const origin of r.pin.origins ?? []) await kubo.connect(origin).catch(() => undefined);
            // Fetch the whole tree without pinning, check it, and pin only what was asked for.
            const graph = await fetchTree(kubo, [r.pin.cid]);
            const refusal = await (opts.check ?? unilogCheck)({ cid: r.pin.cid, graph, kubo });
            if (refusal) throw new Error(refusal);
            const keep = opts.keepDependencies ? Object.keys(graph.packages) : [r.pin.cid];
            for (const cid of keep) {
                await kubo.pin(cid);
                pinned.push(cid);
            }
            r.status = 'pinned';
            r.tree = keep;
            r.info = {};
        } catch (e) {
            // Nothing is pinned until the package has passed its check. Only an error while pinning (from Kubo)
            // can leave pins behind: undo those. Then collect garbage, so the node stops serving what it refused.
            r.status = 'failed';
            r.info = { reason: (e as Error).message };
            await release(pinned);
            collect();
        }
        save();
    }

    const send = (res: http.ServerResponse, status: number, body?: unknown) => {
        res.writeHead(status, body === undefined ? {} : { 'content-type': 'application/json' });
        res.end(body === undefined ? undefined : JSON.stringify(body));
    };
    const fail = (res: http.ServerResponse, status: number, reason: string, details?: string) =>
        send(res, status, { error: { reason, ...(details && { details }) } });
    const authorized = (req: http.IncomingMessage) => {
        if (!opts.tokens?.length) return true;
        const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
        return !!m && opts.tokens.includes(m[1] as string);
    };
    const readBody = (req: http.IncomingMessage) =>
        new Promise<string>((resolve, reject) => {
            let data = '';
            req.on('data', (c: Buffer) => {
                data += c.toString();
                if (data.length > 1_000_000) reject(new Error('too large'));
            });
            req.on('end', () => resolve(data));
            req.on('error', reject);
        });

    const server = http.createServer((req, res) => {
        void (async () => {
            const url = new URL(req.url ?? '/', 'http://dpm');
            const parts = url.pathname.split('/').filter(Boolean);
            try {
                if (parts[0] !== 'pins' || parts.length > 2) return fail(res, 404, 'NOT_FOUND');

                if (parts.length === 1 && req.method === 'GET') {
                    const cids = url.searchParams.get('cid')?.split(',').filter(Boolean);
                    const states = (url.searchParams.get('status') ?? 'pinned').split(',') as PinState[];
                    const limit = Math.min(Number(url.searchParams.get('limit') ?? 10) || 10, 1000);
                    const matching = requests
                        .filter((r) => states.includes(r.status) && (!cids || cids.includes(r.pin.cid)))
                        .reverse();
                    return send(res, 200, {
                        count: matching.length,
                        results: matching.slice(0, limit).map(publicStatus),
                    });
                }

                if (parts.length === 1 && req.method === 'POST') {
                    if (!authorized(req)) return fail(res, 401, 'UNAUTHORIZED', 'A valid access token is required');
                    let pin: Pin;
                    try {
                        pin = JSON.parse(await readBody(req)) as Pin;
                    } catch {
                        return fail(res, 400, 'BAD_REQUEST', 'The body must be a JSON object: { "cid": ... }');
                    }
                    if (typeof pin?.cid !== 'string' || !isCid(pin.cid))
                        return fail(res, 400, 'BAD_REQUEST', `Not a CID: ${JSON.stringify(pin?.cid)}`);
                    const r: Request = {
                        requestid: crypto.randomUUID(),
                        status: 'queued',
                        created: new Date().toISOString(),
                        pin: {
                            cid: pin.cid,
                            ...(typeof pin.name === 'string' && { name: pin.name }),
                            ...(Array.isArray(pin.origins) && {
                                origins: pin.origins.filter((o) => typeof o === 'string'),
                            }),
                        },
                        delegates,
                        info: {},
                    };
                    requests.push(r);
                    save();
                    enqueue(r);
                    return send(res, 202, publicStatus(r));
                }

                const r = requests.find((x) => x.requestid === parts[1]);
                if (!r) return fail(res, 404, 'NOT_FOUND', `No pin request ${parts[1]}`);
                if (req.method === 'GET') return send(res, 200, publicStatus(r));
                if (req.method === 'DELETE')
                    return fail(res, 405, 'METHOD_NOT_ALLOWED', 'This server never removes what it keeps');
                return fail(res, 404, 'NOT_FOUND');
            } catch (e) {
                return fail(res, 500, 'INTERNAL_SERVER_ERROR', (e as Error).message);
            }
        })();
    });

    return { http: server, delegates, idle: () => queue };
}
