/**
 * What `unilog-server` does before it starts serving: reading its arguments, and what it prints at startup. Kept
 * apart from `main.ts` so it can be tested without starting anything.
 */

export const HELP = `Usage: unilog-server [--help | --version]

Starts a Unilog server: an IPFS pinning service that keeps a package only if it and everything it depends on
check with Unilog. It is configured by environment variables, not arguments:

  PORT, HOST   where to listen (default 3000, all interfaces)
  KUBO_API     the server's own Kubo node's HTTP API (default http://127.0.0.1:5001; keep it private).
               Give the server a Kubo of its own: after refusing a package, it deletes everything unpinned there.
  DATA_DIR     where pin requests are stored (default ~/.unilog-server)
  TOKENS       comma-separated access tokens; if set, pushing needs one
  ANNOUNCE     comma-separated multiaddrs of the node, for clients to connect to (default: the node's own)
  KEEP_DEPS    1: keep each package's dependencies too, not only what was pushed
`;

/** What the command line asks for. Anything but `--help` or `--version` is an error: nothing starts. */
export function parseArgs(argv: readonly string[]): 'run' | 'help' | 'version' {
    if (argv.length === 0) return 'run';
    if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) return 'help';
    if (argv.length === 1 && (argv[0] === '--version' || argv[0] === '-V')) return 'version';
    throw new Error(
        `unilog-server takes no arguments other than --help or --version (got: ${argv.join(' ')}). ` +
            'It is configured by environment variables: see unilog-server --help.',
    );
}

/** Whether an IPv4 address is one other machines on the internet can reach (not loopback, private, ...). */
function publicIPv4(ip: string): boolean {
    const [a = -1, b = -1] = ip.split('.').map(Number);
    return !(
        a === 0 ||
        a === 10 ||
        a === 127 ||
        (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
        (a === 169 && b === 254) || // link-local
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168)
    );
}

/** Whether an IPv6 address is one other machines on the internet can reach. */
function publicIPv6(ip: string): boolean {
    const x = ip.toLowerCase();
    return !(
        x === '::' ||
        x === '::1' ||
        /^f[cd]/.test(x) || // unique local
        /^fe[89ab]/.test(x) || // link-local
        x.startsWith('::ffff:') || // IPv4-mapped
        x.startsWith('64:ff9b:') // NAT64
    );
}

/**
 * The node's addresses worth giving to people who want to peer with it: ones reachable from the internet, and
 * direct. Left out: loopback, private and link-local addresses (only this machine or its network can use them),
 * relayed ones (`p2p-circuit`, through other people's nodes), and ones with a `certhash` (their certificates
 * change, so a saved address stops working).
 */
export function peerableAddresses(addresses: readonly string[]): string[] {
    return addresses.filter((a) => {
        if (a.includes('/p2p-circuit') || a.includes('/certhash/')) return false;
        const [, proto, host = ''] = a.split('/');
        if (proto === 'ip4') return publicIPv4(host);
        if (proto === 'ip6') return publicIPv6(host);
        return proto === 'dns' || proto === 'dns4' || proto === 'dns6' || proto === 'dnsaddr';
    });
}

export interface StartupInfo {
    version: string;
    port: number;
    /** HOST, if set. */
    host?: string;
    kuboVersion: string;
    kuboApi: string;
    /** Whether KUBO_API was set; if not, the server uses the default local Kubo, likely the operator's own. */
    kuboApiSet: boolean;
    tokens: boolean;
    /** ANNOUNCE, if set: shown as is. */
    announced?: readonly string[];
    /** The node's own addresses. */
    nodeAddresses: readonly string[];
    keepDependencies: boolean;
}

/** What the server prints when it starts: warnings first, then how to use it. */
export function startupMessages(s: StartupInfo): { warnings: string[]; lines: string[] } {
    const warnings: string[] = [];
    const everywhere = !s.host || s.host === '0.0.0.0' || s.host === '::';
    if (!s.tokens && everywhere)
        warnings.push(
            `anyone who can reach port ${s.port} on this machine can push packages to this server. ` +
                'Set TOKENS to require a token, or HOST=127.0.0.1 to accept pushes from this machine only.',
        );
    if (!s.kuboApiSet)
        warnings.push(
            `using the Kubo at ${s.kuboApi}, the default. If that is your own node, give the server one of its own ` +
                '(set KUBO_API): after refusing a package, the server deletes everything unpinned on its node.',
        );

    const lines = [
        `unilog-server ${s.version} listening on ${s.host ?? '*'}:${s.port}, using Kubo ${s.kuboVersion} at ${s.kuboApi}`,
        'keeping packages that check with Unilog, for good (nothing is ever removed)',
        s.tokens ? 'pushing needs one of the TOKENS' : 'anyone may push (set TOKENS to require a token)',
        s.keepDependencies
            ? "keeping packages' dependencies too"
            : 'keeping only what was pushed (KEEP_DEPS=1 keeps dependencies too)',
        `clients push here with: ipfs pin remote service add <name> http://<this host>:${s.port} <token>`,
    ];
    const peerable = s.announced ?? peerableAddresses(s.nodeAddresses);
    if (peerable.length) {
        lines.push("and fetch from here after peering their node with this server's:");
        for (const a of peerable) lines.push(`  ipfs swarm peering add ${a}`);
    } else {
        lines.push(
            "to fetch from here, clients peer with this server's node, but it has no address others can reach " +
                '(only local, private or relayed ones). Set ANNOUNCE to its public address, ' +
                'e.g. ANNOUNCE=/ip4/<public IP>/tcp/4001/p2p/<its peer ID> (see ipfs id).',
        );
    }
    return { warnings, lines };
}
