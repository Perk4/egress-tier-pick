import assert from "node:assert/strict";
import { test } from "node:test";
import {
  asFlowId,
  asTierNumber,
  assertFailover,
  createHealthBoard,
  defineTiers,
  exit,
  pickNextHop,
  probe,
  writeSample,
  type Clock,
  type HealthBoard,
} from "./pick.ts";

test("defineTiers groups exits by number, lowest first", () => {
  const tiers = defineTiers([
    exit("wg-backup", 2),
    exit("wg-primary-b", 1),
    exit("wg-primary-a", 1),
  ]);
  assert.equal(tiers.groups.length, 2);
  const first = tiers.groups[0];
  const second = tiers.groups[1];
  assert.ok(first !== undefined && second !== undefined);
  assert.equal(first.tier, asTierNumber(1));
  assert.deepEqual(
    first.exits.map((item) => item.id),
    ["wg-primary-b", "wg-primary-a"],
  );
  assert.equal(second.tier, asTierNumber(2));
  assert.deepEqual(
    second.exits.map((item) => item.id),
    ["wg-backup"],
  );
});

test("defineTiers rejects an empty list and duplicate ids", () => {
  assert.throws(() => defineTiers([]), /at least one exit/);
  assert.throws(
    () => defineTiers([exit("wg-a", 1), exit("wg-a", 2)]),
    /duplicate exit wg-a/,
  );
});

test("probe returns healthy, unhealthy, missing, and stale", () => {
  let now = 1_000;
  const health = board(() => now, 100);
  const target = exit("wg-a", 1);

  assert.equal(probe(target, health).kind, "unhealthy");

  writeSample(health, target, "healthy");
  assert.equal(probe(target, health).kind, "healthy");

  writeSample(health, target, "unhealthy");
  assert.equal(probe(target, health).kind, "unhealthy");

  writeSample(health, target, "healthy");
  now = 1_101;
  assert.equal(probe(target, health).kind, "unhealthy");
});

test("pickNextHop keeps a flow on the same exit while it is healthy", () => {
  const health = board(() => 0);
  const t1a = exit("wg-a", 1);
  const t1b = exit("wg-b", 1);
  const tiers = defineTiers([t1a, t1b]);
  writeSample(health, t1a, "healthy");
  writeSample(health, t1b, "healthy");

  const flow = asFlowId("conn-1");
  const first = pickNextHop(flow, tiers, health);
  const other = pickNextHop(asFlowId("conn-2"), tiers, health);
  const again = pickNextHop(flow, tiers, health);

  assert.equal(first.kind, "hop");
  assert.equal(other.kind, "hop");
  assert.equal(again.kind, "hop");
  if (first.kind !== "hop" || other.kind !== "hop" || again.kind !== "hop") {
    return;
  }
  assert.equal(first.exit.id, t1a.id);
  assert.equal(other.exit.id, t1b.id);
  assert.equal(again.exit.id, first.exit.id);
});

test("pickNextHop round-robins inside the lowest healthy tier", () => {
  const health = board(() => 0);
  const t1a = exit("wg-a", 1);
  const t1b = exit("wg-b", 1);
  const t2 = exit("wg-c", 2);
  const tiers = defineTiers([t1a, t1b, t2]);
  writeSample(health, t1a, "healthy");
  writeSample(health, t1b, "healthy");
  writeSample(health, t2, "healthy");

  const a = pickNextHop(asFlowId("f1"), tiers, health);
  const b = pickNextHop(asFlowId("f2"), tiers, health);
  const c = pickNextHop(asFlowId("f3"), tiers, health);

  assert.equal(hopId(a), "wg-a");
  assert.equal(hopId(b), "wg-b");
  assert.equal(hopId(c), "wg-a");
});

test("pickNextHop falls through when the preferred tier is empty", () => {
  const health = board(() => 0);
  const t1a = exit("wg-a", 1);
  const t1b = exit("wg-b", 1);
  const t2a = exit("wg-c", 2);
  const t3 = exit("wg-d", 3);
  const tiers = defineTiers([t1a, t1b, t2a, t3]);
  writeSample(health, t1a, "unhealthy");
  writeSample(health, t1b, "unhealthy");
  writeSample(health, t2a, "healthy");
  writeSample(health, t3, "healthy");

  const hop = pickNextHop(asFlowId("f1"), tiers, health);
  assert.equal(hopId(hop), "wg-c");
  if (hop.kind !== "hop") return;
  assert.equal(hop.exit.tier, asTierNumber(2));
});

test("pickNextHop resticks after the sticky exit dies, same lowest tier if it still has a peer", () => {
  const health = board(() => 0);
  const t1a = exit("wg-a", 1);
  const t1b = exit("wg-b", 1);
  const t2 = exit("wg-c", 2);
  const tiers = defineTiers([t1a, t1b, t2]);
  writeSample(health, t1a, "healthy");
  writeSample(health, t1b, "healthy");
  writeSample(health, t2, "healthy");

  const flow = asFlowId("conn-1");
  assert.equal(hopId(pickNextHop(flow, tiers, health)), "wg-a");

  writeSample(health, t1a, "unhealthy");
  const next = pickNextHop(flow, tiers, health);
  assert.equal(hopId(next), "wg-b");
  assert.equal(hopId(pickNextHop(flow, tiers, health)), "wg-b");
});

test("pickNextHop returns none when every exit is down", () => {
  const health = board(() => 0);
  const tiers = defineTiers([exit("wg-a", 1), exit("wg-b", 2)]);
  const hop = pickNextHop(asFlowId("f1"), tiers, health);
  assert.equal(hop.kind, "none");
});

test("assertFailover: dead tier-1, next pick is sticky on tier-2", () => {
  assertFailover();
});

function board(clock: Clock, ttlMs = 5_000): HealthBoard {
  return createHealthBoard({ clock, ttlMs });
}

function hopId(hop: ReturnType<typeof pickNextHop>): string | undefined {
  return hop.kind === "hop" ? hop.exit.id : undefined;
}
