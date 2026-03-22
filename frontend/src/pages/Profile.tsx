import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import {
  MessageSquare,
  ArrowLeft,
  User,
  Building,
  MapPin,
  Save,
  Plus,
  X,
  Key,
  Eye,
  EyeOff,
  Download,
} from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/hooks/use-toast';
import { useUserProfile, ActivityTimeline } from '@/features/profile';
import { useTier } from '@/features/tier';
import { exportConnectionsCsv } from '@/features/connections/utils/csvExport';
import { queryKeys } from '@/shared/lib/queryKeys';
import { encryptWithSealboxB64 } from '@/shared/utils/crypto';
import { createLogger } from '@/shared/utils/logger';
import type { Connection } from '@/shared/types';

const logger = createLogger('Profile');

const Profile = () => {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { ciphertext, setCiphertext, userProfile, updateUserProfile } = useUserProfile();
  const queryClient = useQueryClient();
  const { isFeatureEnabled } = useTier();

  const [profile, setProfile] = useState({
    name: 'Tom, Dick, And Harry',
    title: 'Senior Software Engineer',
    company: 'TechFlow Inc.',
    location: 'San Francisco, CA',
    bio: 'Passionate about building scalable web applications and exploring AI/ML technologies. Always eager to connect with fellow developers and discuss emerging tech trends.',
    interests: ['React', 'TypeScript', 'AI/ML', 'Startups', 'Open Source'],
    linkedinUrl: 'https://linkedin.com/in/tdah',
  });

  const [linkedinCredentials, setLinkedinCredentials] = useState({
    email: '',
    password: '',
  });

  const [showPassword, setShowPassword] = useState(false);
  const [newInterest, setNewInterest] = useState('');
  const [hasStoredCredentials, setHasStoredCredentials] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  const handleInputChange = (field: string, value: string) => {
    setProfile((prev) => ({ ...prev, [field]: value }));
  };

  useEffect(() => {
    // If we already have ciphertext in context, just show the stored banner
    if (ciphertext) {
      setHasStoredCredentials(true);
    }
  }, [ciphertext]);

  useEffect(() => {
    // When user profile context updates, hydrate this page's local editable fields
    (async () => {
      try {
        const data = userProfile as Record<string, unknown> | null;
        if (!data) return;
        const firstName = ((data.first_name as string) || '').trim();
        const lastName = ((data.last_name as string) || '').trim();
        const derivedName = [firstName, lastName].filter(Boolean).join(' ').trim();
        setProfile((prev) => ({
          ...prev,
          name: derivedName || prev.name,
          title: (data.headline as string) || (data.current_position as string) || prev.title || '',
          company: (data.company as string) || prev.company || '',
          location: (data.location as string) || prev.location || '',
          bio: (data.summary as string) || prev.bio || '',
          interests: Array.isArray(data.interests) ? (data.interests as string[]) : prev.interests,
          linkedinUrl: (data.profile_url as string) || prev.linkedinUrl || '',
        }));

        if (data.linkedin_credentials) {
          setHasStoredCredentials(true);
        }
      } catch {
        // Silent fail; do not block profile page if profile isn't initialized yet
      }
    })();
  }, [userProfile]);

  const handleLinkedinCredentialsChange = (field: string, value: string) => {
    setLinkedinCredentials((prev) => ({ ...prev, [field]: value }));
  };

  const addInterest = () => {
    if (newInterest.trim() && !profile.interests.includes(newInterest.trim())) {
      setProfile((prev) => ({
        ...prev,
        interests: [...prev.interests, newInterest.trim()],
      }));
      setNewInterest('');
    }
  };

  const removeInterest = (interest: string) => {
    setProfile((prev) => ({
      ...prev,
      interests: prev.interests.filter((i) => i !== interest),
    }));
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      // Combined payload for a single API call
      let combinedPayload: Record<string, unknown> = {};

      // Transmit over HTTPS/TLS and let backend encrypt with KMS before storing in DynamoDB
      // Never log or store plaintext locally beyond this session memory.
      if (linkedinCredentials.email && linkedinCredentials.password) {
        const payload: { linkedin_credentials: string } = { linkedin_credentials: '' };

        // Optional client-side encryption if sealbox public key is provided.
        const sealboxPubB64 = import.meta.env.VITE_CRED_SEALBOX_PUBLIC_KEY_B64 as
          | string
          | undefined;
        logger.debug('Save credentials - public key check', {
          hasPublicKey: !!sealboxPubB64,
          keyType: typeof sealboxPubB64,
          keyLength: sealboxPubB64 ? sealboxPubB64.length : 0,
          keyPreview: sealboxPubB64 ? sealboxPubB64.substring(0, 20) + '...' : 'undefined',
        });

        if (sealboxPubB64 && typeof sealboxPubB64 === 'string') {
          logger.debug('Encrypting credentials with Sealbox');
          const json = JSON.stringify({
            email: linkedinCredentials.email,
            password: linkedinCredentials.password,
          });
          logger.debug('JSON to encrypt', { length: json.length });

          const ciphertextB64 = await encryptWithSealboxB64(json, sealboxPubB64);
          logger.debug('Encryption complete', { ciphertextLength: ciphertextB64.length });

          payload.linkedin_credentials = `sealbox_x25519:b64:${ciphertextB64}`;
          logger.debug('Full credentials prepared', {
            credentialsLength: payload.linkedin_credentials.length,
          });

          // Update context with ciphertext for app-wide usage
          setCiphertext(payload.linkedin_credentials);
          logger.debug('Credentials set in context');
        } else {
          logger.warn('No public key found, using plaintext fallback');
          // Fallback: send JSON string and rely on backend to encrypt/de-identify and store securely with KMS
          payload.linkedin_credentials = JSON.stringify({
            email: linkedinCredentials.email,
            password: linkedinCredentials.password,
          });
          // Do NOT store plaintext in context
        }

        setHasStoredCredentials(true);

        // Clear password from local component state after saving to reduce exposure in memory
        setLinkedinCredentials((prev) => ({ ...prev, password: '' }));

        combinedPayload.linkedin_credentials = payload.linkedin_credentials;
      }

      // Save everything in a single API call
      const [firstName, ...rest] = profile.name.trim().split(/\s+/);
      const lastName = rest.join(' ').trim();
      combinedPayload = {
        ...combinedPayload,
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

      toast({
        title: 'Profile updated!',
        description: 'Your profile information and credentials status have been saved securely.',
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
          <p className="text-slate-300">
            Update your profile information and LinkedIn credentials.
          </p>
        </div>

        <div className="grid lg:grid-cols-3 gap-8">
          {/* Profile Form */}
          <div className="lg:col-span-2 space-y-6">
            <Card className="bg-white/5 backdrop-blur-md border-white/10">
              <CardHeader>
                <CardTitle className="text-white flex items-center">
                  <User className="h-5 w-5 mr-2" />
                  Basic Information
                </CardTitle>
                <CardDescription className="text-slate-300">
                  This information helps personalize your conversation starters.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid md:grid-cols-2 gap-4">
                  <div>
                    <Label htmlFor="name" className="text-white">
                      Full Name
                    </Label>
                    <Input
                      id="name"
                      data-testid="profile-name-input"
                      value={profile.name}
                      onChange={(e) => handleInputChange('name', e.target.value)}
                      className="bg-white/5 border-white/20 text-white placeholder-slate-400"
                    />
                  </div>
                  <div>
                    <Label htmlFor="title" className="text-white">
                      Job Title
                    </Label>
                    <Input
                      id="title"
                      value={profile.title}
                      onChange={(e) => handleInputChange('title', e.target.value)}
                      className="bg-white/5 border-white/20 text-white placeholder-slate-400"
                    />
                  </div>
                </div>

                <div className="grid md:grid-cols-2 gap-4">
                  <div>
                    <Label htmlFor="company" className="text-white">
                      Company
                    </Label>
                    <Input
                      id="company"
                      data-testid="profile-company-input"
                      value={profile.company}
                      onChange={(e) => handleInputChange('company', e.target.value)}
                      className="bg-white/5 border-white/20 text-white placeholder-slate-400"
                    />
                  </div>
                  <div>
                    <Label htmlFor="location" className="text-white">
                      Location
                    </Label>
                    <Input
                      id="location"
                      value={profile.location}
                      onChange={(e) => handleInputChange('location', e.target.value)}
                      className="bg-white/5 border-white/20 text-white placeholder-slate-400"
                    />
                  </div>
                </div>

                <div>
                  <Label htmlFor="linkedinUrl" className="text-white">
                    LinkedIn Profile URL
                  </Label>
                  <Input
                    id="linkedinUrl"
                    value={profile.linkedinUrl}
                    onChange={(e) => handleInputChange('linkedinUrl', e.target.value)}
                    className="bg-white/5 border-white/20 text-white placeholder-slate-400"
                    placeholder="https://linkedin.com/in/yourprofile"
                  />
                </div>

                <div>
                  <Label htmlFor="bio" className="text-white">
                    Professional Bio
                  </Label>
                  <Textarea
                    id="bio"
                    value={profile.bio}
                    onChange={(e) => handleInputChange('bio', e.target.value)}
                    className="bg-white/5 border-white/20 text-white placeholder-slate-400 min-h-[100px]"
                    placeholder="Tell us about your professional background and interests..."
                  />
                </div>
              </CardContent>
            </Card>

            <Card className="bg-white/5 backdrop-blur-md border-white/10">
              <CardHeader>
                <CardTitle className="text-white">Interests & Expertise</CardTitle>
                <CardDescription className="text-slate-300">
                  Add topics you're passionate about to find better conversation opportunities.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex space-x-2">
                  <Input
                    value={newInterest}
                    onChange={(e) => setNewInterest(e.target.value)}
                    placeholder="Add an interest (e.g., Machine Learning)"
                    className="bg-white/5 border-white/20 text-white placeholder-slate-400"
                    onKeyPress={(e) => e.key === 'Enter' && addInterest()}
                  />
                  <Button
                    onClick={addInterest}
                    variant="outline"
                    className="bg-slate-700 border-white/20 text-white hover:bg-white/10"
                  >
                    <Plus className="h-4 w-4" />
                  </Button>
                </div>

                <div className="flex flex-wrap gap-2">
                  {profile.interests.map((interest, index) => (
                    <Badge
                      key={index}
                      variant="secondary"
                      className="bg-blue-600/20 text-blue-300 hover:bg-blue-600/30"
                    >
                      {interest}
                      <button
                        onClick={() => removeInterest(interest)}
                        className="ml-2 hover:text-red-300"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </Badge>
                  ))}
                </div>
              </CardContent>
            </Card>

            <Card className="bg-white/5 backdrop-blur-md border-white/10">
              <CardHeader>
                <CardTitle className="text-white flex items-center">
                  <Key className="h-5 w-5 mr-2" />
                  LinkedIn Login Credentials
                </CardTitle>
                <CardDescription className="text-slate-300">
                  Store your LinkedIn credentials for automated connection imports and post
                  publishing.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {hasStoredCredentials && (
                  <div className="bg-emerald-600/20 border border-emerald-600/30 rounded-lg p-3">
                    <p className="text-emerald-200 text-sm">
                      Credentials are securely stored. Enter new values below to replace them.
                    </p>
                  </div>
                )}
                <div>
                  <Label htmlFor="linkedinEmail" className="text-white">
                    LinkedIn Email
                  </Label>
                  <Input
                    id="linkedinEmail"
                    type="email"
                    value={linkedinCredentials.email}
                    onChange={(e) => handleLinkedinCredentialsChange('email', e.target.value)}
                    className="bg-white/5 border-white/20 text-white placeholder-slate-400"
                    placeholder="your-email@example.com"
                  />
                </div>
                <div>
                  <Label htmlFor="linkedinPassword" className="text-white">
                    LinkedIn Password
                  </Label>
                  <div className="relative">
                    <Input
                      id="linkedinPassword"
                      type={showPassword ? 'text' : 'password'}
                      value={linkedinCredentials.password}
                      onChange={(e) => handleLinkedinCredentialsChange('password', e.target.value)}
                      className="bg-white/5 border-white/20 text-white placeholder-slate-400 pr-10"
                      placeholder="••••••••"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="absolute right-0 top-0 h-full px-3 py-2 hover:bg-transparent"
                      onClick={() => setShowPassword(!showPassword)}
                    >
                      {showPassword ? (
                        <EyeOff className="h-4 w-4 text-slate-400" />
                      ) : (
                        <Eye className="h-4 w-4 text-slate-400" />
                      )}
                    </Button>
                  </div>
                </div>
                <div className="bg-yellow-600/20 border border-yellow-600/30 rounded-lg p-3">
                  <p className="text-yellow-200 text-sm">
                    <strong>Security Note:</strong> Credentials are transmitted over HTTPS and
                    encrypted at rest in DynamoDB (via AWS KMS). Plaintext credentials are never
                    stored.
                  </p>
                </div>
              </CardContent>
            </Card>

            <Button
              data-testid="save-profile-button"
              onClick={handleSave}
              disabled={isSaving}
              className="w-full bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-700 hover:to-purple-700 text-white"
            >
              <Save className="h-4 w-4 mr-2" />
              {isSaving ? 'Saving…' : 'Save Profile'}
            </Button>
          </div>

          {/* Profile Preview */}
          <div className="space-y-6">
            <Card className="bg-white/5 backdrop-blur-md border-white/10">
              <CardHeader>
                <CardTitle className="text-white">Profile Preview</CardTitle>
                <CardDescription className="text-slate-300">
                  How your profile appears to the AI
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="text-center">
                  <div className="w-16 h-16 bg-gradient-to-r from-blue-500 to-purple-500 rounded-full flex items-center justify-center text-white font-bold text-xl mx-auto mb-3">
                    {profile.name
                      .split(' ')
                      .map((n) => n[0])
                      .join('')}
                  </div>
                  <h3 className="text-white font-semibold text-lg">{profile.name}</h3>
                  <div className="flex items-center justify-center text-slate-300 text-sm mt-1">
                    <User className="h-3 w-3 mr-1" />
                    {profile.title}
                  </div>
                  <div className="flex items-center justify-center text-slate-300 text-sm mt-1">
                    <Building className="h-3 w-3 mr-1" />
                    {profile.company}
                  </div>
                  <div className="flex items-center justify-center text-slate-300 text-sm mt-1">
                    <MapPin className="h-3 w-3 mr-1" />
                    {profile.location}
                  </div>
                </div>

                <Separator className="bg-white/10" />

                <div>
                  <h4 className="text-white font-medium mb-2">Bio</h4>
                  <p className="text-slate-300 text-sm leading-relaxed">{profile.bio}</p>
                </div>

                <div>
                  <h4 className="text-white font-medium mb-2">Interests</h4>
                  <div className="flex flex-wrap gap-1">
                    {profile.interests.map((interest, index) => (
                      <Badge
                        key={index}
                        variant="outline"
                        className="border-blue-400/30 text-blue-300 text-xs"
                      >
                        {interest}
                      </Badge>
                    ))}
                  </div>
                </div>

                <Separator className="bg-white/10" />

                <div>
                  <h4 className="text-white font-medium mb-2">LinkedIn Status</h4>
                  <div className="flex items-center space-x-2">
                    <div
                      className={`w-2 h-2 rounded-full ${hasStoredCredentials || (linkedinCredentials.email && linkedinCredentials.password) ? 'bg-green-500' : 'bg-red-500'}`}
                    />
                    <span className="text-slate-300 text-sm">
                      {hasStoredCredentials ||
                      (linkedinCredentials.email && linkedinCredentials.password)
                        ? 'Connected'
                        : 'Not Connected'}
                    </span>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card className="bg-slate-700 bg-gradient-to-r from-green-600/20 to-blue-600/20 backdrop-blur-md border-white/10">
              <CardContent className="p-4">
                <h4 className="text-white font-semibold mb-2">✨ Pro Tip</h4>
                <p className="text-slate-300 text-sm">
                  Complete your LinkedIn credentials to enable automated connection imports and post
                  publishing features.
                </p>
              </CardContent>
            </Card>
          </div>
        </div>

        <Separator className="bg-white/10 my-8" />

        {/* Export Data */}
        <Card className="bg-white/5 backdrop-blur-md border-white/10" data-testid="export-section">
          <CardHeader>
            <CardTitle className="text-white flex items-center">
              <Download className="h-5 w-5 mr-2" />
              Export Data
            </CardTitle>
            <CardDescription className="text-slate-300">
              Download your connections as a CSV file.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              data-testid="export-csv-button"
              onClick={handleExportCsv}
              disabled={!cachedConnections || cachedConnections.length === 0}
              variant="outline"
              className="border-white/20 text-white hover:bg-white/10 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Download className="h-4 w-4 mr-2" />
              Export Connections
            </Button>
            {(!cachedConnections || cachedConnections.length === 0) && (
              <p className="text-slate-400 text-sm mt-2">
                Visit the Dashboard first to load your connections.
              </p>
            )}
          </CardContent>
        </Card>

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
