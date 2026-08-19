/**
 * Local view-model types for the OpenCode provider-management surfaces.
 *
 * The wire contract is owned by `@omo/shared` (the manage/catalog/mutation
 * DTOs in packages/shared). This module re-exports those DTOs and adds the
 * client-side joined view-model used by the pages. Every secret-bearing
 * field is write-only on the way out — the UI never requests, receives, or
 * renders stored keys/tokens.
 */
export type {
  OpenCodeProviderApplyRequest,
  OpenCodeProviderApplyResponse,
  OpenCodeProviderAuthSetRequest,
  OpenCodeProviderAuthResponse,
  OpenCodeProviderCatalogDto,
  OpenCodeProviderCatalogEntry,
  OpenCodeProviderCustomNpm,
  OpenCodeProviderCustomSpec,
  OpenCodeProviderDesiredEntry,
  OpenCodeProviderDesiredModel,
  OpenCodeProviderListedModel,
  OpenCodeProviderLiveOverlay,
  OpenCodeProviderModelListRequest,
  OpenCodeProviderModelListResponse,
  OpenCodeProviderMutation,
  OpenCodeProviderMutationError,
  OpenCodeProviderOauthAuthorizeRequest,
  OpenCodeProviderOauthAuthorizeResponse,
  OpenCodeProviderOauthCallbackRequest,
  OpenCodeProviderOauthCallbackResponse,
  OpenCodeProviderRestartResult,
  OpenCodeProviderSimulateRequest,
  OpenCodeProviderSimulateResponse,
  OpenCodeProviderSourceKind,
  OpenCodeProvidersManageDto,
  OpenCodeProviderWriteTarget,
} from "@omo/shared";

/** Client-side joined row: desired state + live overlay, keyed by id. */
export interface ManagedProviderRow {
  id: string;
  /** Display name: desired name wins, then live. */
  name?: string;
  desired: import("@omo/shared").OpenCodeProviderDesiredEntry | null;
  live: import("@omo/shared").OpenCodeProviderLiveOverlay | null;
}

/** Result of a status-aware POST/PUT/DELETE helper in ../api. */
export interface StatusResult<T> {
  status: number;
  data: T;
}
