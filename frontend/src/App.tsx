import { lazy, Suspense } from 'react';
import { Toaster } from '@/shared/components/ui/toaster';
import { Toaster as Sonner } from '@/shared/components/ui/sonner';
import { TooltipProvider } from '@/shared/components/ui/tooltip';
import { QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { AuthProvider, ProtectedRoute } from '@/features/auth';
import { TierProvider } from '@/features/tier';
import { UserProfileProvider } from '@/features/profile';
import { HealAndRestoreProvider } from '@/features/workflow';
import { PostComposerProvider } from '@/features/posts';
import { WebSocketProvider } from '@/shared/contexts/WebSocketContext';
import { queryClient } from '@/shared/lib/queryClient';

const Index = lazy(() => import('@/pages/Index'));
const Auth = lazy(() => import('@/pages/Auth'));
const Dashboard = lazy(() => import('@/pages/Dashboard'));
const Profile = lazy(() => import('@/pages/Profile'));
const NotFound = lazy(() => import('@/pages/NotFound'));

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <AuthProvider>
        <WebSocketProvider>
          <TierProvider>
            <UserProfileProvider>
              <PostComposerProvider>
                <HealAndRestoreProvider>
                  <BrowserRouter>
                    <Suspense fallback={null}>
                      <Routes>
                        <Route path="/" element={<Index />} />
                        <Route path="/auth" element={<Auth />} />
                        <Route
                          path="/dashboard"
                          element={
                            <ProtectedRoute>
                              <Dashboard />
                            </ProtectedRoute>
                          }
                        />
                        <Route
                          path="/profile"
                          element={
                            <ProtectedRoute>
                              <Profile />
                            </ProtectedRoute>
                          }
                        />
                        <Route path="*" element={<NotFound />} />
                      </Routes>
                    </Suspense>
                  </BrowserRouter>
                </HealAndRestoreProvider>
              </PostComposerProvider>
            </UserProfileProvider>
          </TierProvider>
        </WebSocketProvider>
      </AuthProvider>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
