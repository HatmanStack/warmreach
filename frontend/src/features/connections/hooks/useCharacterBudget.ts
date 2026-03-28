import { useState, useEffect, useCallback, useRef } from 'react';

interface CharacterBudgets {
  tagBudget: number;
  summaryBudget: number;
}

function computeBudgets(width: number): CharacterBudgets {
  let tagBudget = 48;
  if (width < 380) tagBudget = 18;
  else if (width < 640) tagBudget = 26;
  else if (width < 1024) tagBudget = 34;

  let summaryBudget = 120;
  if (width < 380) summaryBudget = 80;
  else if (width < 640) summaryBudget = 96;
  else if (width < 1024) summaryBudget = 110;

  return { tagBudget, summaryBudget };
}

const DEBOUNCE_MS = 150;

/**
 * Shared hook that computes tag and summary character budgets based on
 * window width. Uses a single debounced resize listener instead of
 * per-instance listeners.
 */
export function useCharacterBudget(): CharacterBudgets {
  const [budgets, setBudgets] = useState<CharacterBudgets>(() => computeBudgets(window.innerWidth));
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleResize = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
    }
    timerRef.current = setTimeout(() => {
      setBudgets(computeBudgets(window.innerWidth));
      timerRef.current = null;
    }, DEBOUNCE_MS);
  }, []);

  useEffect(() => {
    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
      }
    };
  }, [handleResize]);

  return budgets;
}
