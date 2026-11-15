import fs from 'fs';
import os from 'os';
import path from 'path';
import { Graph, Kubo } from '@team-affix/dpm';
import { findSources, UnilogError, Workspace } from '@team-affix/unilog';

/**
 * Checks a package with Unilog, once it and every package it depends on have been fetched (`graph`). Returns
 * Unilog's errors if anything fails, or nothing if it all checks.
 *
 * Every package in the tree is checked, each against its own dependencies only: all of its `.ul` files, with
 * its own folder and its dependencies' folders (direct and indirect) as Unilog's search roots. So whatever the
 * server keeps (the package, and its dependencies too if it keeps those) has been checked in full, files nothing
 * imports included. Each package is written to a folder of its own, side by side, so module names are exactly
 * the files' paths inside their package (`Kant/Ethics.ul` is `Kant.Ethics`), and two packages providing the same
 * module are reported as ambiguous.
 *
 * A package's own `unilog.json`, if it has one, isn't used: the server decides what to check.
 */
export async function unilogCheck({ cid, graph, kubo }: { cid: string; graph: Graph; kubo: Kubo }) {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'unilog-server-'));
    try {
        const folder = (c: string) => path.join(work, c);
        for (const c of Object.keys(graph.packages)) await kubo.exportTo(c, folder(c));

        const errors: string[] = [];
        // The pushed package first, so its errors are reported first.
        for (const c of [cid, ...Object.keys(graph.packages).filter((p) => p !== cid)]) {
            const ws = new Workspace([folder(c), ...dependenciesOf(c, graph).map(folder)]);
            for (const file of findSources(folder(c))) {
                try {
                    ws.loadFile(file);
                } catch (e) {
                    if (!(e instanceof UnilogError)) throw e;
                    // Paths relative to the work folder: "<cid>/Kant/Ethics.ul".
                    const message = e.message.split(work + path.sep).join('');
                    if (!errors.includes(message)) errors.push(message);
                }
            }
        }
        return errors.length ? errors.join('\n') : undefined;
    } finally {
        fs.rmSync(work, { recursive: true, force: true });
    }
}

/** Every package `cid` depends on, directly or not, each once. */
function dependenciesOf(cid: string, graph: Graph): string[] {
    const seen = new Set<string>();
    const visit = (c: string) => {
        for (const d of graph.packages[c]?.deps ?? [])
            if (!seen.has(d)) {
                seen.add(d);
                visit(d);
            }
    };
    visit(cid);
    seen.delete(cid);
    return [...seen];
}
