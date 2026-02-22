import { useState, useEffect, useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  MessageSquare,
  Users,
  Settings,
  UserPlus,
  FileText,
  LogOut,
  AlertCircle,
  Database,
  BarChart3,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/features/auth';
import { useTier } from '@/features/tier';
import { useHealAndRestore } from '@/features/workflow';
import {
  useConnectionsManager,
  NewConnectionsTab,
  VirtualConnectionList,
  ConnectionListSkeleton,
  MessageIntelligencePanel,
} from '@/features/connections';
import { ConversationTopicPanel, MessageModal, useMessageGeneration } from '@/features/messages';
import { useLinkedInSearch } from '@/features/search';
import { NewPostTab } from '@/features/posts';
import { StatusPicker, ProgressIndicator } from '@/features/workflow';
import { useProfileInit } from '@/features/profile';
import { useUserProfile } from '@/features/profile';
import { NoConnectionsState } from '@/shared/components/ui/empty-state';
import { AgentStatusBadge } from '@/shared/components/AgentStatusBadge';

const Dashboard = () => {
  const navigate = useNavigate();
  const { user, signOut } = useAuth();
  const { isFeatureEnabled } = useTier();
  const { startListening } = useHealAndRestore();
  const { userProfile, refreshUserProfile } = useUserProfile();
  const [conversationTopic, setConversationTopic] = useState('');

  // Extracted hooks
  const {
    connections,
    connectionsLoading,
    connectionsError,
    selectedStatus,
    setSelectedStatus,
    activeTags,
    connectionCounts,
    selectedConnections,
    filteredConnections,
    newConnections,
    selectedConnectionsCount,
    fetchConnections,
    handleTagClick,
    toggleConnectionSelection,
    handleConnectionCheckboxChange,
    updateConnectionStatus,
  } = useConnectionsManager();

  const {
    isGeneratingMessages,
    workflowState,
    messageModalOpen,
    selectedConnectionForMessages,
    generatedMessages,
    currentConnectionName,
    progressTracker,
    handleMessageClick,
    handleCloseMessageModal,
    handleSendMessage,
    handleGenerateMessages,
    handleStopGeneration,
    handleApproveAndNext,
    handleSkipConnection,
  } = useMessageGeneration({
    connections,
    selectedConnections,
    conversationTopic,
    userProfile,
  });

  const {
    isSearchingLinkedIn,
    searchLoading,
    searchError,
    searchInfoMessage,
    handleLinkedInSearch,
  } = useLinkedInSearch({ fetchConnections });

  const { isInitializing, initializationMessage, initializationError, initializeProfile } =
    useProfileInit();

  // Start listening for heal and restore notifications
  useEffect(() => {
    startListening();
  }, [startListening]);

  // Fetch user profile once on mount
  useEffect(() => {
    refreshUserProfile();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Display name from user profile context
  const displayName = useMemo(() => {
    const fullName = [userProfile?.first_name, userProfile?.last_name].filter(Boolean).join(' ');
    return fullName || userProfile?.email || user?.firstName || user?.email || 'User';
  }, [userProfile, user]);

  const handleSignOut = async () => {
    await signOut();
    navigate('/');
  };

  const handleInitializeProfile = async () => {
    await initializeProfile(() => {
      fetchConnections();
    });
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-blue-900 to-slate-900">
      {/* Navigation */}
      <nav className="bg-white/5 backdrop-blur-md border-b border-white/10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center py-4">
            <div className="flex items-center space-x-2">
              <MessageSquare className="h-8 w-8 text-blue-400" />
              <span className="text-2xl font-bold text-white">WarmReach</span>
            </div>
            <div className="flex items-center space-x-4">
              <AgentStatusBadge />
              <span className="text-white">Welcome, {displayName}</span>
              {isFeatureEnabled('advanced_analytics') && (
                <Button
                  variant="ghost"
                  className="text-white hover:bg-white/10"
                  onClick={() => navigate('/analytics')}
                >
                  <BarChart3 className="h-4 w-4 mr-2" />
                  Analytics
                </Button>
              )}
              <Button
                variant="ghost"
                className="text-white hover:bg-white/10"
                onClick={() => navigate('/profile')}
              >
                <Settings className="h-4 w-4 mr-2" />
                Profile
              </Button>
              <Button
                variant="ghost"
                data-testid="sign-out-button"
                onClick={handleSignOut}
                className="text-white hover:bg-white/10"
              >
                <LogOut className="h-4 w-4 mr-2" />
                Sign Out
              </Button>
            </div>
          </div>
        </div>
      </nav>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-white mb-2">Your Network Dashboard</h1>
          <p className="text-slate-300">
            Manage your connections, discover new people, and create engaging content.
          </p>
        </div>

        <Tabs defaultValue="connections" className="space-y-6">
          <TabsList className="grid w-full grid-cols-3 bg-white/5 border-white/10">
            <TabsTrigger
              value="connections"
              className="text-white data-[state=active]:bg-blue-600 data-[state=active]:text-white"
            >
              <Users className="h-4 w-4 mr-2" />
              Connections
            </TabsTrigger>
            <TabsTrigger
              value="new-connections"
              className="text-white data-[state=active]:bg-blue-600 data-[state=active]:text-white"
            >
              <UserPlus className="h-4 w-4 mr-2" />
              New Connections
            </TabsTrigger>
            <TabsTrigger
              value="new-post"
              className="text-white data-[state=active]:bg-blue-600 data-[state=active]:text-white"
            >
              <FileText className="h-4 w-4 mr-2" />
              New Post
            </TabsTrigger>
          </TabsList>

          <TabsContent value="connections" className="space-y-6">
            {initializationMessage && (
              <div className="bg-green-600/20 border border-green-500/30 rounded-lg p-3">
                <p className="text-green-200 text-sm font-medium">
                  <strong>Success:</strong> {initializationMessage}
                </p>
              </div>
            )}
            {initializationError && (
              <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-3">
                <p className="text-red-300 text-sm font-medium">
                  <strong>Error:</strong> {initializationError}
                </p>
              </div>
            )}

            <div className="grid lg:grid-cols-3 gap-8">
              <div className="lg:col-span-2">
                {connectionsLoading && (
                  <div className="bg-white/5 backdrop-blur-md border border-white/10 rounded-lg p-6">
                    <div className="flex items-center justify-between mb-4">
                      <h2 className="text-xl font-semibold text-white">Your Connections</h2>
                      <div className="text-sm text-slate-400">Loading...</div>
                    </div>
                    <ConnectionListSkeleton count={5} />
                  </div>
                )}

                {connectionsError && !connectionsLoading && (
                  <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-6">
                    <div className="flex items-center space-x-3">
                      <AlertCircle className="h-5 w-5 text-red-400 flex-shrink-0" />
                      <div>
                        <h3 className="text-red-300 font-medium">Failed to Load Connections</h3>
                        <p className="text-red-400 text-sm mt-1">{connectionsError}</p>
                        <Button
                          variant="outline"
                          size="sm"
                          className="mt-3 border-red-500/30 text-red-300 hover:bg-red-500/10"
                          onClick={fetchConnections}
                        >
                          Try Again
                        </Button>
                      </div>
                    </div>
                  </div>
                )}

                {!connectionsLoading && !connectionsError && (
                  <div
                    data-testid="connections-list"
                    className="bg-white/5 backdrop-blur-md border border-white/10 rounded-lg p-6"
                  >
                    <div className="flex items-center justify-between mb-4">
                      <h2 className="text-xl font-semibold text-white">Your Connections</h2>
                      <div className="flex items-center gap-4">
                        <div className="text-sm text-slate-400">
                          {filteredConnections.length} of {connectionCounts.total} connections
                        </div>
                        <Button
                          onClick={handleInitializeProfile}
                          disabled={isInitializing}
                          className="bg-gradient-to-r from-green-600 to-teal-600 hover:from-green-700 hover:to-teal-700 text-white"
                        >
                          <Database className="h-4 w-4 mr-2" />
                          {isInitializing
                            ? 'Initializing...'
                            : connectionCounts.ally > 0
                              ? 'Refresh'
                              : 'Initialize Profile Database'}
                        </Button>
                      </div>
                    </div>

                    {filteredConnections.length === 0 ? (
                      <NoConnectionsState
                        type="filtered"
                        onRefresh={fetchConnections}
                        onClearFilters={() => setSelectedStatus('all')}
                        className="py-16"
                      />
                    ) : (
                      <VirtualConnectionList
                        connections={filteredConnections}
                        onSelect={toggleConnectionSelection}
                        onMessageClick={handleMessageClick}
                        onTagClick={handleTagClick}
                        activeTags={activeTags}
                        selectedConnectionId={selectedConnections[0]}
                        className="min-h-[500px]"
                        itemHeight={220}
                        showFilters={true}
                        sortBy="name"
                        sortOrder="asc"
                        showCheckboxes={true}
                        selectedConnections={selectedConnections}
                        onCheckboxChange={handleConnectionCheckboxChange}
                      />
                    )}
                  </div>
                )}
              </div>

              <div className="space-y-6">
                <div className="bg-white/5 backdrop-blur-md border border-white/10 rounded-lg p-6">
                  <StatusPicker
                    selectedStatus={selectedStatus}
                    onStatusChange={setSelectedStatus}
                    connectionCounts={connectionCounts}
                  />
                </div>
                <ConversationTopicPanel
                  topic={conversationTopic}
                  onTopicChange={setConversationTopic}
                  onGenerateMessages={handleGenerateMessages}
                  selectedConnectionsCount={selectedConnectionsCount}
                  isGenerating={isGeneratingMessages}
                  onStopGeneration={handleStopGeneration}
                  currentConnectionName={currentConnectionName}
                />
                <ProgressIndicator
                  progressState={progressTracker.progressState}
                  loadingState={progressTracker.loadingState}
                  onCancel={handleStopGeneration}
                  className="mt-4"
                />
                <MessageIntelligencePanel />
              </div>
            </div>
          </TabsContent>

          <TabsContent value="new-connections" className="space-y-6">
            <NewConnectionsTab
              searchResults={newConnections}
              onSearch={handleLinkedInSearch}
              isSearching={isSearchingLinkedIn || searchLoading}
              userId={user?.id || ''}
              connectionsLoading={connectionsLoading}
              connectionsError={connectionsError}
              searchInfoMessage={searchInfoMessage}
              onRefresh={fetchConnections}
              onRemoveConnection={(connectionId: string, newStatus: 'processed' | 'outgoing') => {
                updateConnectionStatus(connectionId, newStatus);
              }}
            />
            {searchError && (
              <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-4">
                <p className="text-red-300">
                  <strong>Error:</strong> {searchError}
                </p>
              </div>
            )}
          </TabsContent>

          <TabsContent value="new-post" className="space-y-6">
            <NewPostTab />
          </TabsContent>
        </Tabs>
      </div>

      {selectedConnectionForMessages && (
        <MessageModal
          isOpen={messageModalOpen}
          connection={selectedConnectionForMessages}
          onClose={handleCloseMessageModal}
          onSendMessage={handleSendMessage}
          prePopulatedMessage={generatedMessages.get(selectedConnectionForMessages.id)}
          isGeneratedContent={workflowState === 'awaiting_approval'}
          showGenerationControls={workflowState === 'awaiting_approval'}
          onApproveAndNext={handleApproveAndNext}
          onSkipConnection={handleSkipConnection}
        />
      )}
    </div>
  );
};

export default Dashboard;
