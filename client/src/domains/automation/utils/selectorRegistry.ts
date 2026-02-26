export interface SelectorStrategy {
  strategy: string;
  selector: string;
}

export type SelectorCascade = SelectorStrategy[];

export type SelectorRegistry = Record<string, SelectorCascade>;
