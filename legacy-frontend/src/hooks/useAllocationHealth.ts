"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePublicClient } from "wagmi";
import { worldChainSepolia } from "@/lib/constants";
import {
  checkAllocationsHealth,
  loadVaultAllocations,
  summarizeReadiness,
  type AllocationHealthMap,
  type AllocationReadiness,
  type VaultAllocation,
} from "@/lib/allocations";

type Address = `0x${string}`;

// Re-check often enough that an allocation going unbacked (tokens spent,
// approval revoked) shows up while the owner is still looking at the page.
const HEALTH_POLL_MS = 12_000;

interface Options {
  /** Only load allocations assigned to this heir. */
  heir?: Address;
}

interface Snapshot {
  /** Which vault/owner/heir this data was loaded for. */
  key: string;
  allocations: VaultAllocation[];
  health: AllocationHealthMap;
  error: string | null;
}

const EMPTY: Snapshot = { key: "", allocations: [], health: {}, error: null };

/**
 * Loads a vault's on-chain allocations and continuously checks whether each
 * one would actually pay out, given what the owner currently holds and has
 * approved.
 */
export function useAllocationHealth(vault: Address | undefined, owner: Address | undefined, options: Options = {}) {
  const publicClient = usePublicClient({ chainId: worldChainSepolia.id });
  const { heir } = options;

  const key = vault ? `${vault}:${owner ?? ""}:${heir ?? ""}`.toLowerCase() : "";

  const [snapshot, setSnapshot] = useState<Snapshot>(EMPTY);

  // The key the latest request was made for, so a slow response for a
  // previous vault can never overwrite the current one.
  const latestKey = useRef(key);
  // Lets the health poll read the latest allocations without re-subscribing.
  const snapshotRef = useRef(snapshot);
  useEffect(() => {
    latestKey.current = key;
    snapshotRef.current = snapshot;
  }, [key, snapshot]);

  // Pure fetch: resolves to the snapshot for the current key, never sets state.
  const fetchSnapshot = useCallback(async (): Promise<Snapshot | null> => {
    if (!publicClient || !vault) return null;
    try {
      const allocations = await loadVaultAllocations(publicClient, vault, { heir });
      const health = owner ? await checkAllocationsHealth(publicClient, owner, allocations) : {};
      return { key, allocations, health, error: null };
    } catch (err) {
      console.error("[AllocationHealth] Failed to load allocations:", err);
      return { ...EMPTY, key, error: "Could not load allocations from the chain." };
    }
  }, [publicClient, vault, owner, heir, key]);

  /** Reloads allocations, e.g. after assigning or removing one. */
  const refresh = useCallback(async () => {
    const next = await fetchSnapshot();
    if (next && latestKey.current === next.key) setSnapshot(next);
  }, [fetchSnapshot]);

  // Re-checks health against the allocations already loaded, without
  // re-reading logs.
  const refreshHealth = useCallback(async () => {
    if (!publicClient || !owner) return;
    const requestKey = key;
    const loaded = snapshotRef.current;
    const current = loaded.key === requestKey ? loaded.allocations : [];
    if (current.length === 0) return;
    try {
      const health = await checkAllocationsHealth(publicClient, owner, current);
      if (latestKey.current === requestKey) {
        setSnapshot((prev) => (prev.key === requestKey ? { ...prev, health } : prev));
      }
    } catch (err) {
      console.error("[AllocationHealth] Health check failed:", err);
    }
  }, [publicClient, owner, key]);

  useEffect(() => {
    let cancelled = false;
    fetchSnapshot().then((next) => {
      if (!cancelled && next) setSnapshot(next);
    });
    return () => {
      cancelled = true;
    };
  }, [fetchSnapshot]);

  useEffect(() => {
    if (!vault || !owner) return;
    const id = setInterval(() => void refreshHealth(), HEALTH_POLL_MS);
    const onFocus = () => void refreshHealth();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(id);
      window.removeEventListener("focus", onFocus);
    };
  }, [vault, owner, refreshHealth]);

  // Data loaded for a different vault/owner/heir is never shown.
  const current = snapshot.key === key ? snapshot : EMPTY;
  const isLoading = Boolean(vault) && snapshot.key !== key;
  const readiness: AllocationReadiness = summarizeReadiness(current.allocations, current.health);

  return {
    allocations: current.allocations,
    health: current.health,
    readiness,
    isLoading,
    error: current.error,
    refresh,
    refreshHealth,
  };
}
