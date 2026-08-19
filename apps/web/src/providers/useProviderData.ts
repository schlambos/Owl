/**
 * Data hook for the provider-management surfaces: manage DTO always,
 * catalog DTO on demand. Fetch errors surface as plain strings — never
 * masked. Refresh after applies re-joins desired + live + write target.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  OpenCodeProviderCatalogDto,
  OpenCodeProvidersManageDto,
} from "@omo/shared";
import { api } from "../api";

export interface ProviderDataState {
  manage: OpenCodeProvidersManageDto | null;
  catalog: OpenCodeProviderCatalogDto | null;
  loading: boolean;
  /** Hard fetch failure (network/HTTP). */
  error: string | null;
  /** Soft per-endpoint issue (e.g. catalog unavailable, manage fine). */
  catalogIssue: string | null;
  /** Refetch manage (and catalog when enabled). */
  refresh: () => Promise<void>;
}

export function useProviderData(opts?: {
  loadCatalog?: boolean;
}): ProviderDataState {
  const loadCatalog = opts?.loadCatalog === true;
  const [manage, setManage] = useState<OpenCodeProvidersManageDto | null>(null);
  const [catalog, setCatalog] = useState<OpenCodeProviderCatalogDto | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [catalogIssue, setCatalogIssue] = useState<string | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    setCatalogIssue(null);
    try {
      if (loadCatalog) {
        const results = await Promise.allSettled([
          api.opencodeProviderManage(),
          api.opencodeProviderCatalog(),
        ]);
        if (!mountedRef.current) return;
        if (results[0].status === "fulfilled") {
          setManage(results[0].value);
        } else {
          setError(
            results[0].reason instanceof Error
              ? results[0].reason.message
              : String(results[0].reason),
          );
        }
        if (results[1].status === "fulfilled") {
          setCatalog(results[1].value);
        } else {
          setCatalogIssue(
            results[1].reason instanceof Error
              ? results[1].reason.message
              : String(results[1].reason),
          );
        }
      } else {
        const dto = await api.opencodeProviderManage();
        if (mountedRef.current) setManage(dto);
      }
    } catch (e) {
      if (mountedRef.current)
        setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [loadCatalog]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { manage, catalog, loading, error, catalogIssue, refresh };
}
