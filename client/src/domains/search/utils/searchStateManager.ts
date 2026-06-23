interface SearchStateInput {
  companyName?: string;
  companyRole?: string;
  companyLocation?: string;
  searchName: string | null;
  searchPassword: string | null;
  credentialsCiphertext?: string;
  jwtToken: string;
  resumeIndex?: number;
  recursionCount?: number;
  lastPartialLinksFile?: string | null;
  extractedCompanyNumber?: string | null;
  extractedGeoNumber?: string | null;
  healPhase?: string | null;
  healReason?: string | null;
  [key: string]: unknown;
}

/**
 * Resolved search state after {@link SearchStateManager.buildInitialState}
 * applies its defaults. Consumers (the search controller) read these fields
 * with compile-time checking instead of an untyped `Record<string, any>`.
 */
export interface SearchState {
  companyName?: string;
  companyRole?: string;
  companyLocation?: string;
  searchName: string | null;
  searchPassword: string | null;
  credentialsCiphertext?: string;
  jwtToken: string;
  resumeIndex: number;
  recursionCount: number;
  lastPartialLinksFile: string | null;
  extractedCompanyNumber: string | null;
  extractedGeoNumber: string | null;
  healPhase: string | null;
  healReason: string | null;
  [key: string]: unknown;
}

export class SearchStateManager {
  static buildInitialState({
    companyName,
    companyRole,
    companyLocation,
    searchName,
    searchPassword,
    credentialsCiphertext,
    jwtToken,
    resumeIndex = 0,
    recursionCount = 0,
    lastPartialLinksFile = null,
    extractedCompanyNumber = null,
    extractedGeoNumber = null,
    healPhase = null,
    healReason = null,
    ...opts
  }: SearchStateInput): SearchState {
    return {
      companyName,
      companyRole,
      companyLocation,
      searchName,
      searchPassword,
      credentialsCiphertext,
      jwtToken,
      resumeIndex,
      recursionCount,
      lastPartialLinksFile,
      extractedCompanyNumber,
      extractedGeoNumber,
      healPhase,
      healReason,
      ...opts,
    };
  }
}
