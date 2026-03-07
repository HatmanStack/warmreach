import { renderHook, act } from '@testing-library/react';
import { useToast } from '../use-toast';
import { describe, it, expect, vi } from 'vitest';

describe('useToast', () => {
  it('should add a toast', () => {
    const { result } = renderHook(() => useToast());

    act(() => {
      result.current.toast({ title: 'Test', description: 'Message' });
    });

    expect(result.current.toasts).toHaveLength(1);
    expect(result.current.toasts[0].title).toBe('Test');
  });

  it('should dismiss a specific toast', () => {
    const { result } = renderHook(() => useToast());
    let toastId = '';

    act(() => {
      const t = result.current.toast({ title: 'Test' });
      toastId = t.id;
    });

    expect(result.current.toasts[0].open).toBe(true);

    act(() => {
      result.current.dismiss(toastId);
    });

    expect(result.current.toasts[0].open).toBe(false);
  });

  it('should dismiss all toasts', () => {
    const { result } = renderHook(() => useToast());

    act(() => {
      result.current.toast({ title: 'T1' });
      result.current.toast({ title: 'T2' });
    });

    act(() => {
      result.current.dismiss();
    });

    expect(result.current.toasts.every((t) => !t.open)).toBe(true);
  });

  it('should remove a toast after delay', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useToast());

    act(() => {
      result.current.toast({ title: 'Removable' });
    });

    act(() => {
      result.current.dismiss();
    });

    // TOAST_REMOVE_DELAY is very long in the file (1000000), but let's test the branch
    act(() => {
      vi.runAllTimers();
    });

    expect(result.current.toasts).toHaveLength(0);
    vi.useRealTimers();
  });

  it('should update a toast', () => {
    const { result } = renderHook(() => useToast());
    let t: any;

    act(() => {
      t = result.current.toast({ title: 'Initial' });
    });

    act(() => {
      t.update({ id: t.id, title: 'Updated' });
    });

    expect(result.current.toasts[0].title).toBe('Updated');
  });

  it('should handle onOpenChange', () => {
    const { result } = renderHook(() => useToast());

    act(() => {
      result.current.toast({ title: 'Test' });
    });

    const toast = result.current.toasts[0];
    act(() => {
      if (toast.onOpenChange) {
        toast.onOpenChange(false);
      }
    });

    expect(result.current.toasts[0].open).toBe(false);
  });
});
