// The way to the owner's LAN, being tried: Tailscale in a sandbox of its own, never the workers' (they read untrusted
// pages with the open internet). Its network reaches only Tailscale's own servers, so the tailnet is all it can reach,
// and the tailnet's ACLs limit its tagged node to the hosts and ports the owner chooses.
//
// For now this is the check that it can work at all: in a sandbox named `dreamwalker-tailscale-*`, download Tailscale's
// static binaries, start tailscaled in userspace mode with its state in memory, and see whether `tailscale up` gets as
// far as asking to log in, which needs the control plane, and what `tailscale netcheck` finds. No key is given, so
// nothing joins the tailnet. It runs in the background; the owner polls for it.
import type { NetworkPolicy } from "plinthwick";
import type { Box } from "./sandbox-env.ts";

/** A sandbox that reaches Tailscale's servers and nothing else on the internet. */
export const TAILSCALE_NETWORK: NetworkPolicy = { egress: "allowlist", allow: ["*.tailscale.com", "*.tailscale.io", "tailscale.com"] };

/** The sandboxes that get it, by name. */
export const isTailscaleSandbox = (name: string) => name.startsWith("dreamwalker-tailscale");

/** For the experiment only: one named `...-open` reaches the whole internet, to tell the allowlist's part from the sandbox's. */
export const tailscaleNetwork = (name: string): NetworkPolicy => (name.endsWith("-open") ? { egress: "allow_all" } : TAILSCALE_NETWORK);

const CHECK = `
cd /root
echo "--- download"
INDEX=$(curl -fsS -m 20 "https://pkgs.tailscale.com/stable/?mode=json") || { echo "couldn't read Tailscale's package index"; exit 1; }
TGZ=$(printf '%s' "$INDEX" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).Tarballs.amd64))')
echo "$TGZ"
if [ ! -x tailscale/tailscaled ]; then
	curl -fsS -m 60 "https://pkgs.tailscale.com/stable/$TGZ" -o ts.tgz || { echo "couldn't download $TGZ"; exit 1; }
	mkdir -p tailscale && tar xzf ts.tgz -C tailscale --strip-components=1 && rm ts.tgz
fi
./tailscale/tailscale version | head -1
echo "--- plain requests"
for u in "https://controlplane.tailscale.com/key?v=88" "http://controlplane.tailscale.com/key?v=88" "https://derp1.tailscale.com/derp/probe"; do printf '%s %s\n' "$(curl -sS -m 10 -o /dev/null -w '%{http_code}' "$u" 2>&1)" "$u"; done
curl -sv -m 10 -o /dev/null https://controlplane.tailscale.com/ 2>&1 | grep -iE "issuer|subject:|SSL connection" | head -3
echo "--- an upgrade, as Tailscale's control protocol makes"
curl -sS -m 10 -o /dev/null -w '%{http_code}\n' -H "Connection: upgrade" -H "Upgrade: tailscale-control-protocol" -X POST "https://controlplane.tailscale.com/ts2021" 2>&1
echo "--- tailscaled"
mkdir -p /root/ts
pkill tailscaled 2>/dev/null
nohup ./tailscale/tailscaled --tun=userspace-networking --state=mem: --socket=/root/ts/sock --socks5-server=localhost:1055 --no-logs-no-support >/root/ts/log 2>&1 &
sleep 4
echo "--- up (no key: it should ask to log in)"
timeout 25 ./tailscale/tailscale --socket=/root/ts/sock up --timeout=20s --hostname=dreamwalker-probe 2>&1 | head -6
echo "--- netcheck"
timeout 25 ./tailscale/tailscale --socket=/root/ts/sock netcheck 2>&1 | head -24
echo "--- log"
tail -20 /root/ts/log
pkill tailscaled 2>/dev/null
echo "--- done"
`;

export type TailscaleCheck = { name: string; startedAt: string; finishedAt?: string; output?: string; error?: string };

/** Runs the check in the sandbox `box()` gives, one at a time, keeping the latest in memory. */
export function tailscaleCheck(box: (name: string) => Promise<Box>) {
	let latest: TailscaleCheck | undefined;
	return {
		start(name: string): TailscaleCheck {
			if (latest !== undefined && latest.finishedAt === undefined) return latest;
			const check: TailscaleCheck = { name, startedAt: new Date().toISOString() };
			latest = check;
			void (async () => {
				try {
					const out = await (await box(name)).run(["sh", "-c", CHECK]);
					check.output = `${out.stdout}${out.stderr ? `\n--- stderr\n${out.stderr}` : ""}`.slice(-12_000);
				} catch (error) {
					check.error = error instanceof Error ? error.message : String(error);
				} finally {
					check.finishedAt = new Date().toISOString();
				}
			})();
			return check;
		},
		latest: () => latest,
	};
}
