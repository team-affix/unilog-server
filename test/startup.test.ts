import { describe, expect, it } from 'vitest';
import { parseArgs, peerableAddresses, StartupInfo, startupMessages } from '../src/startup';

const ID = '12D3KooWSjXZAdqB6YFacYU9kCFUakR8WXSEPUhbRxewBjJKVJmP';
const RELAY = '12D3KooWMdjC7VFSPVc9xHsdfg1gPUYRq3aUiK9N1b5siyZPXoTd';

describe('arguments', () => {
    it('starts with none, and answers --help and --version', () => {
        expect(parseArgs([])).toBe('run');
        expect(parseArgs(['--help'])).toBe('help');
        expect(parseArgs(['-h'])).toBe('help');
        expect(parseArgs(['--version'])).toBe('version');
        expect(parseArgs(['-V'])).toBe('version');
    });

    it('refuses anything else, so nothing starts by mistake', () => {
        for (const argv of [['--port', '3000'], ['start'], ['--version', '--help']])
            expect(() => parseArgs(argv)).toThrow(/takes no arguments other than --help or --version/);
    });
});

describe('addresses to peer with', () => {
    it('keeps public, direct addresses and leaves out local, private, relayed and certhash ones', () => {
        // A laptop's real addresses, as Kubo reports them (shortened to one of each kind).
        const addresses = [
            `/ip4/127.0.0.1/tcp/4001/p2p/${ID}`,
            `/ip4/192.168.0.249/tcp/4001/p2p/${ID}`,
            `/ip4/10.150.167.106/udp/4001/quic-v1/p2p/${ID}`,
            `/ip4/172.17.0.1/tcp/4001/p2p/${ID}`,
            `/ip4/91.134.10.210/tcp/4001/p2p/${RELAY}/p2p-circuit/p2p/${ID}`,
            `/ip4/203.0.113.7/udp/4001/webrtc-direct/certhash/uEiCuO43zf3GE/p2p/${ID}`,
            `/ip6/::1/tcp/4001/p2p/${ID}`,
            `/ip6/fe80::1/tcp/4001/p2p/${ID}`,
            `/ip6/fd00::5/tcp/4001/p2p/${ID}`,
            `/ip6/64:ff9b::587:a25c/tcp/4001/p2p/${ID}`,
            // Public and direct: these are kept.
            `/ip4/203.0.113.7/tcp/4001/p2p/${ID}`,
            `/ip4/203.0.113.7/udp/4001/quic-v1/p2p/${ID}`,
            `/ip6/2001:db8::7/tcp/4001/p2p/${ID}`,
            `/dns4/server.example.org/tcp/4001/p2p/${ID}`,
        ];
        expect(peerableAddresses(addresses)).toEqual([
            `/ip4/203.0.113.7/tcp/4001/p2p/${ID}`,
            `/ip4/203.0.113.7/udp/4001/quic-v1/p2p/${ID}`,
            `/ip6/2001:db8::7/tcp/4001/p2p/${ID}`,
            `/dns4/server.example.org/tcp/4001/p2p/${ID}`,
        ]);
    });

    it('treats only the private parts of 172.x and 100.x as private', () => {
        expect(
            peerableAddresses([`/ip4/172.32.0.1/tcp/4001/p2p/${ID}`, `/ip4/100.128.0.1/tcp/4001/p2p/${ID}`]),
        ).toHaveLength(2);
        expect(peerableAddresses([`/ip4/172.31.0.1/tcp/4001/p2p/${ID}`, `/ip4/100.64.0.1/tcp/4001/p2p/${ID}`])).toEqual(
            [],
        );
    });
});

describe('startup messages', () => {
    const base: StartupInfo = {
        version: '1.0.0',
        port: 3000,
        kuboVersion: '0.43.1',
        kuboApi: 'http://127.0.0.1:5001',
        kuboApiSet: false,
        tokens: false,
        nodeAddresses: [`/ip4/127.0.0.1/tcp/4001/p2p/${ID}`, `/ip4/203.0.113.7/tcp/4001/p2p/${ID}`],
        keepDependencies: false,
    };

    it('warns when anyone can push, and when it uses the default local Kubo', () => {
        const { warnings } = startupMessages(base);
        expect(warnings).toHaveLength(2);
        expect(warnings[0]).toMatch(/anyone who can reach port 3000 .* can push/);
        expect(warnings[1]).toMatch(/using the Kubo at http:\/\/127\.0\.0\.1:5001, the default/);
    });

    it("doesn't warn when it needs a token or listens on this machine only, with its own Kubo", () => {
        expect(startupMessages({ ...base, tokens: true, kuboApiSet: true }).warnings).toEqual([]);
        expect(startupMessages({ ...base, host: '127.0.0.1', kuboApiSet: true }).warnings).toEqual([]);
        expect(startupMessages({ ...base, host: '0.0.0.0', kuboApiSet: true }).warnings).toHaveLength(1);
    });

    it('prints one peering command per public address', () => {
        const peering = startupMessages(base).lines.filter((l) => l.includes('ipfs swarm peering add'));
        expect(peering).toEqual([`  ipfs swarm peering add /ip4/203.0.113.7/tcp/4001/p2p/${ID}`]);
    });

    it('prints ANNOUNCE as given', () => {
        const announced = [`/ip4/127.0.0.1/tcp/4001/p2p/${ID}`];
        const peering = startupMessages({ ...base, announced }).lines.filter((l) => l.includes('peering add'));
        expect(peering).toEqual([`  ipfs swarm peering add /ip4/127.0.0.1/tcp/4001/p2p/${ID}`]);
    });

    it('says so, and what to do, when no address is reachable from outside', () => {
        const { lines } = startupMessages({ ...base, nodeAddresses: [`/ip4/192.168.0.249/tcp/4001/p2p/${ID}`] });
        expect(lines.some((l) => l.includes('peering add'))).toBe(false);
        expect(lines.join('\n')).toMatch(/has no address others can reach .* Set ANNOUNCE/);
    });
});
