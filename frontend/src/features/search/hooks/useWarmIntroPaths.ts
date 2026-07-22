// Reviewed against pro 2026-07-20: the get_warm_intro_paths route move
// (analytics -> network-intelligence, analytics-insights split) does not affect
// this community stub, which returns a no-op result and never calls the API.
export interface IntroPathNode {
  profileId: string;
  firstName: string;
  lastName: string;
  position: string;
  company: string;
  relationshipScore: number;
}

export interface IntroPath {
  nodes: IntroPathNode[];
  hopCount: number;
  averageScore: number;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function useWarmIntroPaths(targetProfileId: string | null) {
  return { data: null, isLoading: false, error: null, refetch: () => {} };
}
