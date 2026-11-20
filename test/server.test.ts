import { execFile } from 'child_process';
import { promisify } from 'util';
import { describe, expect, it } from 'vitest';
import { writeManifest } from '@team-affix/dpm';
import { pack } from '@team-affix/dpm/client';
import { Check, KuboAdmin, PinningService, PinStatus } from '../src';
import { hasLocally, IPFS_BIN, startNode, startServer, tmpDir, writeTree } from './helpers';

/** A Unilog package's folder: the given files, and a dpm.json listing its dependencies. */
function project(files: Record<string, string>, deps: string[] = []): string {
    const dir = tmpDir('unilog-pkg-');
    writeTree(dir, files);
    writeManifest(dir, { deps });
    return dir;
}

/** Runs the stock `ipfs` command against `node`, as a user would (asynchronously: the server is in this process). */
async function ipfs(node: KuboAdmin, ...args: string[]): Promise<string> {
    const port = new URL(node.api).port;
    const { stdout } = await promisify(execFile)(IPFS_BIN as string, [`--api=/ip4/127.0.0.1/tcp/${port}`, ...args]);
    return stdout.trim();
}

/** What a user runs to publish: dpm pack. Returns the CID. */
const publish = (dir: string, node: KuboAdmin): Promise<string> => pack(dir, node);

/**
 * What a user runs to push: ipfs pin remote add --service=home <cid>. If the server refuses, the error also gives
 * the reason the server recorded (ipfs reports only that it refused), so a failure says why.
 */
async function push(node: KuboAdmin, url: string, cid: string, token = 'none'): Promise<string> {
    const services = await ipfs(node, 'pin', 'remote', 'service', 'ls');
    if (!services.split('\n').some((l) => l.startsWith('home ')))
        await ipfs(node, 'pin', 'remote', 'service', 'add', 'home', url, token);
    try {
        return await ipfs(node, 'pin', 'remote', 'add', '--service=home', cid);
    } catch (e) {
        const reason = (await decision(url, cid).catch(() => undefined))?.info?.reason;
        throw new Error(`${(e as Error).message}${reason ? `\nThe server's reason: ${reason}` : ''}`);
    }
}

/** The server's recorded decision on a CID. */
async function decision(url: string, cid: string): Promise<PinStatus | undefined> {
    const [s] = await new PinningService(url).list({ cid: [cid], status: ['pinned', 'failed'] });
    return s;
}

const REFUSED = /remote service failed to pin/;

const LOGIC = { 'Logic/Prelude.ul': 'false_elim : \\C. false => C;\npair : \\A B. A => B => and A B;\n' };
const KANT = {
    'Kant/Beliefs.ul':
        'import Logic.Prelude;\nlying_is_wrong : \\X. lies X => wrong X;\nlie : lies answering;\n' +
        'wrong_to_lie : wrong answering = lying_is_wrong lie;\n',
};
/** A wrong proof: lying_is_wrong lie proves "wrong answering", not "wrong everything". */
const BAD = { 'Bad/Claim.ul': 'import Kant.Beliefs;\neverything_is_wrong : \\X. wrong X = lying_is_wrong lie;\n' };

describe.skipIf(!IPFS_BIN)('Unilog server (real Kubo nodes)', { timeout: 60_000 }, () => {
    if (!IPFS_BIN) it.skip('needs the ipfs binary: set IPFS_BIN or put Kubo on the PATH', () => undefined);

    /** An author's node with Logic and Kant (which imports Logic) published, and a server. */
    async function world(opts: { keepDependencies?: boolean; tokens?: string[]; check?: Check } = {}) {
        const [author, serverNode] = await Promise.all([startNode(), startNode()]);
        const { url, server } = await startServer({ kubo: serverNode, ...opts });
        const logic = await publish(project(LOGIC), author);
        const kant = await publish(project(KANT, [logic]), author);
        return { author, serverNode, url, server, logic, kant };
    }

    describe('checking with Unilog', () => {
        it('keeps a package that checks, fetched from the author over IPFS', async () => {
            const { author, serverNode, url, logic } = await world();
            expect(await push(author, url, logic)).toMatch(/Status: pinned/);
            expect(await serverNode.pins()).toContain(logic);
        });

        it('checks a package against its dependencies, and keeps only what was pushed', async () => {
            const { author, serverNode, url, server, logic, kant } = await world();
            expect(await push(author, url, kant)).toMatch(/Status: pinned/);
            await server.idle();
            expect(await serverNode.pins()).toContain(kant);
            // Fetched and checked, but not pinned: cached like anything Kubo fetches, until garbage collection.
            expect(await serverNode.pins()).not.toContain(logic);
        });

        it('keeps dependencies too when configured to', async () => {
            const { author, serverNode, url, logic, kant } = await world({ keepDependencies: true });
            await push(author, url, kant);
            expect(await serverNode.pins()).toEqual(expect.arrayContaining([kant, logic]));
        });

        it("refuses a wrong proof, with Unilog's error as the reason, and deletes what it fetched", async () => {
            const { author, serverNode, url, server, kant } = await world();
            const bad = await publish(project(BAD, [kant]), author);
            await expect(push(author, url, bad)).rejects.toThrow(REFUSED);
            const refused = await decision(url, bad);
            expect(refused?.status).toBe('failed');
            expect(refused?.info?.reason).toContain(`${bad}/Bad/Claim.ul:2:`);
            expect(refused?.info?.reason).toMatch(/Cannot apply lying_is_wrong to lie/);
            await server.idle();
            expect(await serverNode.pins()).not.toContain(bad);
            expect(await hasLocally(serverNode, bad)).toBe(false);
        });

        it('checks every file of every package in the tree, even ones nothing imports', async () => {
            const { author, url } = await world();
            // A dependency with a broken file that the pushed package doesn't import.
            const dep = await publish(project({ ...LOGIC, 'Logic/Broken.ul': 'x : p = nothing;\n' }), author);
            const app = await publish(project({ 'App/Main.ul': 'import Logic.Prelude;\n' }, [dep]), author);
            await expect(push(author, url, app)).rejects.toThrow(REFUSED);
            expect((await decision(url, app))?.info?.reason).toContain(`${dep}/Logic/Broken.ul`);
        });

        it("ignores a package's own unilog.json: every .ul file is checked", async () => {
            const { author, url } = await world();
            const cid = await publish(
                project({
                    ...LOGIC,
                    'Extra/Broken.ul': 'x : p = nothing;\n',
                    'unilog.json': JSON.stringify({ roots: ['.'], check: ['Logic'] }),
                }),
                author,
            );
            await expect(push(author, url, cid)).rejects.toThrow(REFUSED);
            expect((await decision(url, cid))?.info?.reason).toContain('Extra/Broken.ul');
        });

        it('refuses two dependencies that provide the same module', async () => {
            const { author, url, logic } = await world();
            const other = await publish(project({ 'Logic/Prelude.ul': 'false_elim : \\C. false => C;\n' }), author);
            const app = await publish(
                project({ 'App/Main.ul': 'import Logic.Prelude;\nx : \\C. false => C = false_elim;\n' }, [
                    logic,
                    other,
                ]),
                author,
            );
            await expect(push(author, url, app)).rejects.toThrow(REFUSED);
            expect((await decision(url, app))?.info?.reason).toMatch(/Module Logic.Prelude is ambiguous/);
        });

        it('lets a package import only its own dependencies', async () => {
            const { author, url } = await world();
            // Kant imports Logic but doesn't list it in dpm.json: it can't see it.
            const cid = await publish(project(KANT), author);
            await expect(push(author, url, cid)).rejects.toThrow(REFUSED);
            expect((await decision(url, cid))?.info?.reason).toMatch(/Module Logic.Prelude not found/);
        });

        it('refuses a package whose tree cannot be completed', async () => {
            const { author, url } = await world();
            const missing = await ipfs(
                author,
                'add',
                '-r',
                '-Q',
                '--only-hash',
                project({ 'Nowhere/X.ul': 'gone : p;\n' }),
            );
            const cid = await publish(project(LOGIC, [missing]), author);
            await expect(push(author, url, cid)).rejects.toThrow(REFUSED);
            expect((await decision(url, cid))?.info?.reason).toContain(`Could not fetch ${missing}`);
        }, 120_000);
    });

    describe('Pinning Service API', () => {
        it('requires a token to add pins when tokens are set; reading is open', async () => {
            const { author, url, logic } = await world({ tokens: ['secret'] });
            await expect(new PinningService(url).add({ cid: logic })).rejects.toThrow(/401/);
            await expect(new PinningService(url, 'wrong').add({ cid: logic })).rejects.toThrow(/401/);
            expect(await push(author, url, logic, 'secret')).toMatch(/Status: pinned/);
            expect((await new PinningService(url).list({ cid: [logic] })).map((s) => s.pin.cid)).toEqual([logic]);
        });

        it('lists requests by CID and state', async () => {
            const { author, url, logic, kant } = await world();
            await push(author, url, logic);
            await push(author, url, kant);
            const api = new PinningService(url);
            expect((await api.list({ cid: [kant] })).map((s) => s.pin.cid)).toEqual([kant]);
            expect((await api.list()).map((s) => s.pin.cid).sort()).toEqual([kant, logic].sort());
            expect(await api.list({ status: ['failed'] })).toEqual([]);
        });

        it('never removes what it keeps: removing a request is refused, with or without a token', async () => {
            const { author, serverNode, url, server, logic } = await world({ tokens: ['secret'] });
            await push(author, url, logic, 'secret');
            const [request] = await new PinningService(url).list({ cid: [logic] });
            for (const headers of [{}, { authorization: 'Bearer secret' }] as Record<string, string>[]) {
                const res = await fetch(`${url}/pins/${request?.requestid}`, { method: 'DELETE', headers });
                expect(res.status).toBe(405);
            }
            await expect(
                ipfs(author, 'pin', 'remote', 'rm', '--service=home', `--cid=${logic}`, '--force'),
            ).rejects.toThrow(/405|never removes/);
            await server.idle();
            expect(await serverNode.pins()).toContain(logic);
        });

        it('can be given another check (e.g. for tests)', async () => {
            const { author, url, logic } = await world({ check: async () => 'not today' });
            await expect(push(author, url, logic)).rejects.toThrow(REFUSED);
            expect((await decision(url, logic))?.info?.reason).toBe('not today');
        });

        it("answers nothing of Kubo's RPC API, which stays private", async () => {
            const { url } = await startServer({ kubo: await startNode() });
            for (const command of ['pin/ls', 'id', 'version', 'pin/rm', 'pin/add', 'repo/gc', 'config', 'shutdown']) {
                const res = await fetch(`${url}/api/v0/${command}`, { method: 'POST' });
                expect(res.status).toBe(404);
            }
        });

        it('rejects a request that is not for a CID', async () => {
            const { url } = await startServer({ kubo: await startNode() });
            await expect(new PinningService(url).add({ cid: 'Kant@123' })).rejects.toThrow(
                /400 BAD_REQUEST: Not a CID/,
            );
        });
    });
});
