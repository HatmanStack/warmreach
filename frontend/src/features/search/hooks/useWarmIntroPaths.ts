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
