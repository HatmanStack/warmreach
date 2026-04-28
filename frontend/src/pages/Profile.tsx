import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { MessageSquare, ArrowLeft, Save } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/hooks/use-toast';
import { useUserProfile, ActivityTimeline } from '@/features/profile';
import { useProfileForm } from '@/features/profile/hooks/useProfileForm';
import { ProfileForm } from '@/features/profile/components/ProfileForm';
import { InterestsEditor } from '@/features/profile/components/InterestsEditor';
import { DesktopClientDownloadPrompt } from '@/features/profile/components/DesktopClientDownloadPrompt';
import { ProfilePreview } from '@/features/profile/components/ProfilePreview';
import { ExportData } from '@/features/profile/components/ExportData';
import { useTier } from '@/features/tier';
import { exportConnectionsCsv } from '@/features/connections/utils/csvExport';
import { queryKeys } from '@/shared/lib/queryKeys';
import { createLogger } from '@/shared/utils/logger';
import type { Connection } from '@/shared/types';

const logger = createLogger('Profile');

const Profile = () => {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { userProfile, updateUserProfile } = useUserProfile();
  const queryClient = useQueryClient();
  const { isFeatureEnabled } = useTier();

  const {
    profile,
    newInterest,
    setNewInterest,
    isSaving,
    setIsSaving,
    handleInputChange,
    addInterest,
    removeInterest,
  } = useProfileForm(userProfile as Record<string, unknown> | null);

  // Credentials live in the desktop client, not the web app. There's no
  // ciphertext in the web tab to inspect — the previous "Connected" pill
  // derived from React state would have always been wrong post-architecture
  // change. ProfilePreview accordingly no longer receives a connectivity
  // signal from this page; an explicit client-health handshake can be
  // wired in later if we want to display real desktop-client status.

  const handleSave = async () => {
    setIsSaving(true);
    try {
      // LinkedIn credentials are NOT handled here — they live exclusively in
      // the desktop client on the user's machine. This save flow only
      // touches profile metadata (name, headline, company, etc.).
      const [firstName, ...rest] = profile.name.trim().split(/\s+/);
      const lastName = rest.join(' ').trim();
      const combinedPayload: Record<string, unknown> = {
        first_name: firstName || undefined,
        last_name: lastName || undefined,
        headline: profile.title || undefined,
        current_position: profile.title || undefined,
        company: profile.company || undefined,
        location: profile.location || undefined,
        summary: profile.bio || undefined,
        interests: Array.isArray(profile.interests) ? profile.interests : undefined,
        profile_url: profile.linkedinUrl || undefined,
      };

      await updateUserProfile(combinedPayload);
      logger.debug('Profile saved');

      toast({
        title: 'Profile updated!',
        description: 'Your profile has been saved.',
      });
      navigate('/dashboard', { replace: true });
    } catch (error) {
      toast({
        title: 'Save failed',
        description:
          error instanceof Error ? error.message : 'Unable to save your profile at this time.',
        variant: 'destructive',
      });
    } finally {
      setIsSaving(false);
    }
  };

  const handleExportCsv = () => {
    const cachedData = queryClient.getQueryData(queryKeys.connections.all);
    const connections = (cachedData as Connection[]) || [];
    const includeProFields = isFeatureEnabled('relationship_strength_scoring');
    exportConnectionsCsv(connections, { includeProFields });
  };

  const cachedConnections = queryClient.getQueryData(queryKeys.connections.all) as
    | Connection[]
    | undefined;

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-blue-900 to-slate-900">
      {/* Navigation */}
      <nav className="bg-white/5 backdrop-blur-md border-b border-white/10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center py-4">
            <div className="flex items-center space-x-4">
              <Button
                variant="ghost"
                onClick={() => navigate('/dashboard')}
                className="text-white hover:bg-white/10"
              >
                <ArrowLeft className="h-4 w-4 mr-2" />
                Back to Dashboard
              </Button>
              <div className="flex items-center space-x-2">
                <MessageSquare className="h-8 w-8 text-blue-400" />
                <span className="text-2xl font-bold text-white">WarmReach</span>
              </div>
            </div>
          </div>
        </div>
      </nav>

      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-white mb-2">Your Profile</h1>
          <p className="text-slate-300">Update your profile information.</p>
        </div>

        <div className="grid lg:grid-cols-3 gap-8">
          {/* Profile Form */}
          <div className="lg:col-span-2 space-y-6">
            <ProfileForm profile={profile} onInputChange={handleInputChange} />

            <InterestsEditor
              interests={profile.interests}
              newInterest={newInterest}
              onNewInterestChange={setNewInterest}
              onAddInterest={addInterest}
              onRemoveInterest={removeInterest}
            />

            <DesktopClientDownloadPrompt hideAlreadyInstalled />

            <Button
              data-testid="save-profile-button"
              onClick={handleSave}
              disabled={isSaving}
              className="w-full bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-700 hover:to-purple-700 text-white"
            >
              <Save className="h-4 w-4 mr-2" />
              {isSaving ? 'Saving...' : 'Save Profile'}
            </Button>
          </div>

          {/* Profile Preview */}
          <ProfilePreview profile={profile} hasStoredCredentials={false} />
        </div>

        <Separator className="bg-white/10 my-8" />

        <ExportData
          onExportCsv={handleExportCsv}
          hasConnections={!!cachedConnections && cachedConnections.length > 0}
        />

        <Separator className="bg-white/10 my-8" />

        {/* Activity Timeline */}
        <Card
          className="bg-white/5 backdrop-blur-md border-white/10"
          data-testid="activity-section"
        >
          <CardContent className="pt-6">
            <ActivityTimeline />
          </CardContent>
        </Card>
      </div>
    </div>
  );
};

export default Profile;
