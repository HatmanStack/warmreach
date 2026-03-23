import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { User } from 'lucide-react';
import type { ProfileData } from '../hooks/useProfileForm';

interface ProfileFormProps {
  profile: ProfileData;
  onInputChange: (field: keyof ProfileData, value: string) => void;
}

export function ProfileForm({ profile, onInputChange }: ProfileFormProps) {
  return (
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
              onChange={(e) => onInputChange('name', e.target.value)}
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
              onChange={(e) => onInputChange('title', e.target.value)}
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
              onChange={(e) => onInputChange('company', e.target.value)}
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
              onChange={(e) => onInputChange('location', e.target.value)}
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
            onChange={(e) => onInputChange('linkedinUrl', e.target.value)}
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
            onChange={(e) => onInputChange('bio', e.target.value)}
            className="bg-white/5 border-white/20 text-white placeholder-slate-400 min-h-[100px]"
            placeholder="Tell us about your professional background and interests..."
          />
        </div>
      </CardContent>
    </Card>
  );
}
