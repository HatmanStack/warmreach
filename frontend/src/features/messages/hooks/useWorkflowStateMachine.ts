import { useState, useCallback } from 'react';

type WorkflowState =
  | 'idle'
  | 'generating'
  | 'awaiting_approval'
  | 'stopping'
  | 'completed'
  | 'error';

export function useWorkflowStateMachine() {
  const [state, setState] = useState<WorkflowState>('idle');
  const [currentIndex, setCurrentIndex] = useState(0);

  const startGenerating = useCallback(() => {
    setState('generating');
    setCurrentIndex(0);
  }, []);

  const awaitApproval = useCallback(() => {
    setState('awaiting_approval');
  }, []);

  const approveAndContinue = useCallback(() => {
    setState('generating');
    setCurrentIndex((i) => i + 1);
  }, []);

  const stop = useCallback(() => {
    setState('stopping');
  }, []);

  const complete = useCallback(() => {
    setState('completed');
  }, []);

  const setError = useCallback(() => {
    setState('error');
  }, []);

  const reset = useCallback(() => {
    setState('idle');
    setCurrentIndex(0);
  }, []);

  return {
    state,
    currentIndex,
    isGenerating: state === 'generating',
    isAwaitingApproval: state === 'awaiting_approval',
    isStopping: state === 'stopping',
    startGenerating,
    awaitApproval,
    approveAndContinue,
    stop,
    complete,
    setError,
    reset,
  };
}
