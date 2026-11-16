# unilog-server

An IPFS server which restricts uploads to DPM packages containing only valid unilog code.

It is a standard **IPFS pinning service** in front of a Kubo node of its own. People push packages to it with Kubo's own command, `ipfs pin remote add`, and it keeps a package only if the package, and everything it depends on, checks with [Unilog](https://github.com/team-affix/unilog). Packages are [DPM](https://github.com/team-affix/dpm) packages: folders identified by their IPFS CID, listing the CIDs they depend on in a `dpm.json`.

## What it does with a push

1. **Fetches** the package and its whole dependency tree over IPFS, following each package's `dpm.json`, **without pinning** anything. Kubo checks every block against its CID. Nothing is uploaded to the server: its Kubo fetches from the pusher's node (or any node that has the content).
2. **Checks** every package in the tree with Unilog: all of its `.ul` files, against its own dependencies only. Each package sits in a folder of its own, so `Kant/Ethics.ul` in a package is the module `Kant.Ethics`, and a package can import only what its `dpm.json` lists (directly or through its dependencies). A package's own `unilog.json`, if it has one, is ignored: the server checks every `.ul` file.
3. **If everything checks,** it pins the pushed package (and, with `KEEP_DEPS=1`, its dependencies too) and reports it `pinned`. **If not,** it reports it `failed`, with Unilog's errors as the reason (e.g. `<cid>/Bad/Claim.ul:3:37: Cannot apply lying_is_wrong to …`), and garbage-collects its node so it doesn't serve what it refused.
4. **Keeps what it accepted for good.** Removing a request (`DELETE /pins/:requestid`, i.e. `ipfs pin remote rm`) is refused with `405`: a package others build on can't disappear.

Since a CID fixes its whole tree, a package the server keeps has been checked exactly as it is, permanently.

## Using a server

With [Kubo](https://github.com/ipfs/kubo/releases) running on your machine (`ipfs init --profile=unixfs-v1-2025` once, then `ipfs daemon`):

```bash
ipfs pin remote service add home https://<server> <token>   # once (any token if the server needs none)
ipfs swarm peering add <an address the server printed>       # to fetch from it (or Peering.Peers in Kubo's config)

ipfs add -r -Q "$(dpm pack)"                                 # publish your project: prints its CID
ipfs pin remote add --service=home <cid>                     # push it: "Status: pinned", or refused
dpm package tree <cid> --flat | xargs -n1 ipfs pin remote add --service=home   # push it with its whole tree
```

`ipfs` reports only *that* a push was refused. The reason is in the server's API: `GET /pins?cid=<cid>&status=failed`, field `info.reason`.

## Running a server

```bash
npm install -g https://github.com/team-affix/unilog-server/releases/latest/download/unilog-server.tgz   # Node.js 20+
KUBO_API=http://127.0.0.1:5001 PORT=3000 unilog-server
```

| Variable | Meaning |
|---|---|
| `PORT`, `HOST` | Where to listen (default 3000, all interfaces) |
| `KUBO_API` | The server's own Kubo node's HTTP API (default `http://127.0.0.1:5001`). Keep it private. |
| `DATA_DIR` | Where pin requests are stored (default `~/.unilog-server`) |
| `TOKENS` | Comma-separated access tokens. If set, pushing needs one. Reading is open. |
| `ANNOUNCE` | Comma-separated multiaddrs of the server's node, for clients to peer with (default: the node's own) |
| `KEEP_DEPS` | `1`: pin each package's dependencies too. By default only what was pushed is pinned; the dependencies are fetched and checked, but stay only as cached data, as with anything a Kubo node fetches. |

At startup it prints how to push to it, and the addresses others can peer with: only public, direct ones (not local, private or relayed ones). If the node has none, as behind NAT, set `ANNOUNCE` to its public address. It also warns when anyone who can reach its port can push (no `TOKENS`, listening on all interfaces), and when it uses the default local Kubo, which is likely your own node. `unilog-server --help` lists the settings, and `unilog-server --version` prints the version; it takes no other arguments.

Give the server a Kubo node of its own: after a refusal it garbage-collects the node, which deletes anything unpinned. Expose the server's port and Kubo's peer-to-peer port (4001), never Kubo's HTTP API (5001). `docker compose up` runs both (see `docker-compose.yml`).

### The API

The standard [IPFS Pinning Service API](https://ipfs.github.io/pinning-services-api-spec/):

| Request | Meaning |
|---|---|
| `POST /pins` `{ "cid", "name"?, "origins"? }` | Please keep `cid`. `origins` are multiaddrs of nodes that have it. Needs a token if `TOKENS` is set. |
| `GET /pins?cid=…&status=…&limit=…` | Requests, filtered by CID and state (default `pinned`) |
| `GET /pins/:requestid` | One request's status |
| `DELETE /pins/:requestid` | Refused (`405`): the server never removes what it keeps |

Statuses go `queued`, then `pinning`, then `pinned` or `failed`. Each carries the server's `delegates`: multiaddrs of its node. A failure's reason is in `info.reason`. Nothing else is answered; Kubo's own API is never exposed.

## How it fits together

- **[Unilog](https://github.com/team-affix/unilog)** is the language. It knows nothing about DPM or servers.
- **[DPM](https://github.com/team-affix/dpm)** is the package manager: `dpm.json`, `dpm pack`, `dpm package tree`, `dpm install`. It knows nothing about Unilog.
- **IPFS (Kubo)** stores, moves and verifies everything.
- **This server** is the one piece that knows both: it uses DPM's library to fetch a package's tree, and Unilog's library to check it. Unilog's verdict is exactly `unilog check`'s, since it's the same code.

## Releases

Built files are never committed. They are attached to [GitHub Releases](https://github.com/team-affix/unilog-server/releases) by CI:

| File | What it is |
|---|---|
| `unilog-server-<version>.cjs` | the server as a single file: `node unilog-server-<version>.cjs` |
| `team-affix-unilog-server-<version>.tgz` | the npm package: `npm i -g ./team-affix-unilog-server-<version>.tgz` |

Each release also has the same files without the version in their names (`unilog-server.cjs`, `unilog-server.tgz`), so `https://github.com/team-affix/unilog-server/releases/latest/download/<name>` always gets the newest.

To release: set a new version in `package.json` and merge to `main`. After the tests pass, CI tags the merge commit `v<version>` and publishes the release.

## Development

```bash
npm ci
npm test          # vitest, with real Kubo nodes (IPFS_BIN or ipfs on the PATH; skipped without one)
npm run test:e2e  # every user story: real Kubo nodes, this server, the dpm and unilog commands, real packages
npm run lint
npm run build
npm run bundle    # single-file unilog-server in release/
```

`npm run test:e2e` runs 71 checks, covering: publishing and pushing, installing from the server with the authors offline, a three-level tree, a refused wrong proof, version propagation, pinning a tree, opening a package with `ipfs get`, two packages with the same module, refused removal, the errors users can hit, and reading through a remote Kubo. It runs in CI too. To try it against an unreleased Unilog, point it at a built checkout with `UNILOG_DIR=<path>`.

Layout:

```
src/check.ts       the Unilog check of a fetched tree
src/server.ts      the Pinning Service API server
src/kubo-admin.ts  the requests the server makes on its own Kubo node (pin, garbage collection, ...)
src/pinning.ts     the Pinning Service API's types, and a client for it
src/main.ts        the unilog-server command
test/              tests with real Kubo nodes, and test/e2e/user-stories.sh
```
