import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { User, Building, MapPin } from 'lucide-react';
import type { ProfileData } from '../hooks/useProfileForm';
import type { LinkedInCredentialsData } from '../hooks/useLinkedInCredentials';

interface ProfilePreviewProps {
  profile: ProfileData;
  hasStoredCredentials: boolean;
  linkedinCredentials: LinkedInCredentialsData;
}

export function ProfilePreview({
  profile,
  hasStoredCredentials,
  linkedinCredentials,
}: ProfilePreviewProps) {
  return (
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
                {hasStoredCredentials || (linkedinCredentials.email && linkedinCredentials.password)
                  ? 'Connected'
                  : 'Not Connected'}
              </span>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="bg-slate-700 bg-gradient-to-r from-green-600/20 to-blue-600/20 backdrop-blur-md border-white/10">
        <CardContent className="p-4">
          <h4 className="text-white font-semibold mb-2">Pro Tip</h4>
          <p className="text-slate-300 text-sm">
            Complete your LinkedIn credentials to enable automated connection imports and post
            publishing features.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
