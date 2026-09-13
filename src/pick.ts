import assert from "node:assert/strict";

export type ExitId = string & { readonly __brand: "ExitId" };
export type FlowId = string & { readonly __brand: "FlowId" };
export type TierNumber = number & { readonly __brand: "TierNumber" };

export type Clock = () => number;

export type Health =
  | { kind: "healthy" }
  | { kind: "unhealthy" };

export type ProbeSample = {
  kind: Health["kind"];
  at: number;
};

export type HealthBoard = {
  clock: Clock;
  samples: Map<ExitId, ProbeSample>;
  ttlMs: number;
};

export type Exit = {
  id: ExitId;
  tier: TierNumber;
};

export type TierGroup = {
  tier: TierNumber;
  exits: readonly Exit[];
};

export type Tiers = {
  groups: readonly TierGroup[];
  stick: Map<FlowId, ExitId>;
  cursor: Map<TierNumber, number>;
};

export type Hop =
  | { kind: "hop"; exit: Exit }
  | { kind: "none" };

export function asExitId(raw: string): ExitId {
  if (raw.length === 0) throw new Error("empty exit id");
  return raw as ExitId;
}

export function asFlowId(raw: string): FlowId {
  if (raw.length === 0) throw new Error("empty flow id");
  return raw as FlowId;
}

export function asTierNumber(n: number): TierNumber {
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`invalid tier: ${n}`);
  }
  return n as TierNumber;
}

export function exit(id: string, tier: number): Exit {
  return { id: asExitId(id), tier: asTierNumber(tier) };
}

export function createHealthBoard(opts: {
  clock: Clock;
  ttlMs?: number;
}): HealthBoard {
  return {
    clock: opts.clock,
    samples: new Map(),
    ttlMs: opts.ttlMs ?? 5_000,
  };
}

export function writeSample(
  health: HealthBoard,
  target: Exit,
  kind: Health["kind"],
): void {
  health.samples.set(target.id, { kind, at: health.clock() });
}

export function defineTiers(exits: readonly Exit[]): Tiers {
  if (exits.length === 0) {
    throw new Error("defineTiers: need at least one exit");
  }

  const seen = new Set<string>();
  const buckets = new Map<number, Exit[]>();

  for (const item of exits) {
    const id = asExitId(item.id);
    const tier = asTierNumber(item.tier);
    if (seen.has(id)) {
      throw new Error(`defineTiers: duplicate exit ${id}`);
    }
    seen.add(id);

    const copy: Exit = { id, tier };
    const bucket = buckets.get(tier);
    if (bucket === undefined) {
      buckets.set(tier, [copy]);
    } else {
      bucket.push(copy);
    }
  }

  const groups: TierGroup[] = [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([tier, grouped]) => ({
      tier: asTierNumber(tier),
      exits: grouped,
    }));

  return {
    groups,
    stick: new Map(),
    cursor: new Map(),
  };
}

export function probe(target: Exit, health: HealthBoard): Health {
  const sample = health.samples.get(target.id);
  if (sample === undefined) {
    return { kind: "unhealthy" };
  }
  if (health.clock() - sample.at > health.ttlMs) {
    return { kind: "unhealthy" };
  }
  return healthFromKind(sample.kind);
}

export function pickNextHop(
  flowId: FlowId,
  tiers: Tiers,
  health: HealthBoard,
): Hop {
  const stuckId = tiers.stick.get(flowId);
  if (stuckId !== undefined) {
    const stuck = findExit(tiers, stuckId);
    if (stuck !== undefined && isHealthy(probe(stuck, health))) {
      return { kind: "hop", exit: stuck };
    }
  }

  const next = roundRobinLowestTier(tiers, health);
  if (next.kind === "hop") {
    tiers.stick.set(flowId, next.exit.id);
  } else {
    tiers.stick.delete(flowId);
  }
  return next;
}

export function assertFailover(): void {
  const health = createHealthBoard({
    clock: () => 1_700_000_000_000,
    ttlMs: 60_000,
  });
  const t1a = exit("wg-primary-a", 1);
  const t1b = exit("wg-primary-b", 1);
  const t2a = exit("wg-backup-a", 2);
  const t2b = exit("wg-backup-b", 2);
  const tiers = defineTiers([t1a, t1b, t2a, t2b]);

  writeSample(health, t1a, "unhealthy");
  writeSample(health, t1b, "unhealthy");
  writeSample(health, t2a, "healthy");
  writeSample(health, t2b, "healthy");

  const flow = asFlowId("flow-sticky");
  const first = pickNextHop(flow, tiers, health);
  assert.equal(first.kind, "hop");
  if (first.kind !== "hop") {
    throw new Error("expected a hop after tier-1 death");
  }
  assert.equal(first.exit.id, t2a.id);
  assert.equal(first.exit.tier, asTierNumber(2));

  const second = pickNextHop(flow, tiers, health);
  assert.equal(second.kind, "hop");
  if (second.kind !== "hop") {
    throw new Error("expected the hop to stay sticky");
  }
  assert.equal(second.exit.id, first.exit.id);
  assert.equal(second.exit.tier, asTierNumber(2));
}

function healthFromKind(kind: Health["kind"]): Health {
  switch (kind) {
    case "healthy":
      return { kind: "healthy" };
    case "unhealthy":
      return { kind: "unhealthy" };
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

function isHealthy(result: Health): boolean {
  switch (result.kind) {
    case "healthy":
      return true;
    case "unhealthy":
      return false;
    default: {
      const _exhaustive: never = result;
      return _exhaustive;
    }
  }
}

function findExit(tiers: Tiers, id: ExitId): Exit | undefined {
  for (const group of tiers.groups) {
    for (const item of group.exits) {
      if (item.id === id) return item;
    }
  }
  return undefined;
}

function roundRobinLowestTier(tiers: Tiers, health: HealthBoard): Hop {
  for (const group of tiers.groups) {
    const n = group.exits.length;
    if (n === 0) continue;
    const start = tiers.cursor.get(group.tier) ?? 0;
    for (let i = 0; i < n; i++) {
      const idx = (start + i) % n;
      const candidate = group.exits[idx];
      if (candidate === undefined) continue;
      if (isHealthy(probe(candidate, health))) {
        tiers.cursor.set(group.tier, (idx + 1) % n);
        return { kind: "hop", exit: candidate };
      }
    }
  }
  return { kind: "none" };
}
