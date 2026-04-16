interface SearchStateInput {
  companyName: string;
  companyRole: string;
  companyLocation: string;
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
  }: SearchStateInput): Record<string, unknown> {
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
