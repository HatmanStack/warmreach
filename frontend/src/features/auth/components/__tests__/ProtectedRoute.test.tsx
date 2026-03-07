import { render, screen } from '@testing-library/react';
import ProtectedRoute from '../ProtectedRoute';
import { AuthContext, type AuthContextType } from '@/features/auth/contexts/AuthContext';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';

describe('ProtectedRoute', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const renderWithAuth = (children: React.ReactNode, authValue: Partial<AuthContextType>) => {
    return render(
      <AuthContext.Provider value={authValue as AuthContextType}>
        <MemoryRouter initialEntries={['/protected']}>
          <Routes>
            <Route path="/auth" element={<div>Auth Page</div>} />
            <Route path="/protected" element={<ProtectedRoute>{children}</ProtectedRoute>} />
          </Routes>
        </MemoryRouter>
      </AuthContext.Provider>
    );
  };

  it('should show loading state', () => {
    renderWithAuth(<div>Protected Content</div>, {
      user: null,
      loading: true,
    });

    expect(screen.getByText('Loading...')).toBeInTheDocument();
  });

  it('should redirect to /auth if not authenticated', () => {
    renderWithAuth(<div>Protected Content</div>, {
      user: null,
      loading: false,
    });

    expect(screen.getByText('Auth Page')).toBeInTheDocument();
    expect(screen.queryByText('Protected Content')).not.toBeInTheDocument();
  });

  it('should render children if authenticated', () => {
    renderWithAuth(<div>Protected Content</div>, {
      user: { id: 'u1' } as any,
      loading: false,
    });

    expect(screen.getByText('Protected Content')).toBeInTheDocument();
  });
});
