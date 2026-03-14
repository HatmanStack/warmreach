import { useState, useCallback, useRef } from 'react';
import { createLogger } from '@/shared/utils/logger';

const logger = createLogger('useSessionStorage');

function useSessionStorage<T>(
  key: string,
  initialValue: T
): [T, (value: T | ((prevValue: T) => T)) => void, () => void, () => void] {
  // Capture initialValue on first render to avoid re-render loops
  // when callers pass inline objects/arrays (e.g. useSessionStorage('key', []))
  const initialValueRef = useRef(initialValue);

  // Get value from sessionStorage or use initial value
  const [storedValue, setStoredValue] = useState<T>(() => {
    try {
      const item = window.sessionStorage.getItem(key);
      return item ? JSON.parse(item) : initialValueRef.current;
    } catch (error) {
      logger.warn(`Error reading sessionStorage key "${key}"`, { error });
      return initialValueRef.current;
    }
  });

  // Set value in both state and sessionStorage.
  // Uses a ref to read the latest value without depending on storedValue,
  // keeping setValue referentially stable across renders.
  const latestValueRef = useRef(storedValue);
  // Note: in React concurrent mode, a discarded render may briefly set this to
  // a stale value. Accepted tradeoff for setValue stability in a storage hook.
  latestValueRef.current = storedValue;

  const setValue = useCallback(
    (value: T | ((prevValue: T) => T)) => {
      try {
        const valueToStore = value instanceof Function ? value(latestValueRef.current) : value;
        window.sessionStorage.setItem(key, JSON.stringify(valueToStore));
        setStoredValue(valueToStore);
      } catch (error) {
        logger.error(`Error setting sessionStorage key "${key}"`, { error });
      }
    },
    [key]
  );

  // Remove value from sessionStorage
  const removeValue = useCallback(() => {
    try {
      window.sessionStorage.removeItem(key);
      setStoredValue(initialValueRef.current);
    } catch (error) {
      logger.error(`Error removing sessionStorage key "${key}"`, { error });
    }
  }, [key]);

  // Re-read value from sessionStorage (useful when external code writes to this key)
  const rehydrate = useCallback(() => {
    try {
      const item = window.sessionStorage.getItem(key);
      setStoredValue(item ? JSON.parse(item) : initialValueRef.current);
    } catch (error) {
      logger.warn(`Error rehydrating sessionStorage key "${key}"`, { error });
      setStoredValue(initialValueRef.current);
    }
  }, [key]);

  return [storedValue, setValue, removeValue, rehydrate];
}

export default useSessionStorage;
