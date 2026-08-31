# egress-tier-pick

Tiny TypeScript stand-in for OPNsense gateway groups: numbered egress tiers, a stub health probe, sticky pick, and failover.

This is not OPNsense, not WireGuard, and not a firewall. There is no ZimaBoard, no MAC/TTL disguise, and no real ISP.

Source itch: [Tyrannical ISP Cut My Internet. So I Built This.](https://www.youtube.com/watch?v=_XTIdZuaitI) (cachito labs).

The video's box is OPNsense on a dual-NIC ZimaBoard: disguise the WAN, then send egress out WireGuard tunnels grouped into tiers with sticky round-robin failover. This repo teaches that routing policy as four functions.

## The four primitives

`src/pick.ts` owns the policy. There is no packet path.

| Function | OPNsense gateway group |
| --- | --- |
| `defineTiers(exits)` | System → Gateways → Group. Lower numbers are preferred (tier 1 first). Exits that share a tier are one pool. |
| `probe(exit, health)` | `dpinger` gateway monitor. Stub: look up an injectable health map. Missing or stale (`clock() − at > ttl`) is unhealthy. |
| `pickNextHop(flowId, tiers, health)` | Policy route. Sticky: a `flowId` keeps its exit while `probe` says healthy. Otherwise round-robin inside the lowest-numbered tier that still has a healthy exit. An empty tier falls through. |
| `assertFailover()` | Mark every tier-1 exit unhealthy. The next pick for that flow lands in tier 2 and stays there. |

A flow that already sits on a healthy backup does not fail back when tier 1 recovers. Stickiness lasts until that exit itself goes unhealthy, then pick again. `pickNextHop` records the sticky table and the per-tier cursor on the `Tiers` object `defineTiers` returned.

## How to run it

Needs Node 22 or newer (type stripping, no build step).

```bash
npm install
npm test
npm run typecheck
```

## define → probe → pick → failover

```ts
import {
  asFlowId,
  createHealthBoard,
  defineTiers,
  exit,
  pickNextHop,
  probe,
  writeSample,
} from "./src/pick.ts";

const primaryA = exit("wg-primary-a", 1);
const primaryB = exit("wg-primary-b", 1);
const backupA = exit("wg-backup-a", 2);
const tiers = defineTiers([primaryA, primaryB, backupA]);

const health = createHealthBoard({ clock: () => 0, ttlMs: 5_000 });
writeSample(health, primaryA, "healthy");
writeSample(health, primaryB, "healthy");
writeSample(health, backupA, "healthy");

probe(primaryA, health); // { kind: "healthy" }

const flow = asFlowId("laptop-443");
pickNextHop(flow, tiers, health); // wg-primary-a
pickNextHop(flow, tiers, health); // still wg-primary-a

writeSample(health, primaryA, "unhealthy");
writeSample(health, primaryB, "unhealthy");
pickNextHop(flow, tiers, health); // wg-backup-a, then sticky
```

`assertFailover()` is the same story with two healthy tier-2 exits, as a unit test.

## What this is not

No OPNsense VM, WireGuard handshake, pf rules, MAC spoof, TTL rewrite, or live monitor IP. Health is a `Map` plus a clock.
