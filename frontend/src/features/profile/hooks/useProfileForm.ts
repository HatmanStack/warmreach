import { useState, useEffect } from 'react';

export interface ProfileData {
  name: string;
  title: string;
  company: string;
  location: string;
  bio: string;
  interests: string[];
  linkedinUrl: string;
}

// Empty defaults: never seed demo values into the form. The hydration
// effect below replaces these with whatever the API returns; until that
// resolves, fields render with their placeholder text. Anything we put
// here gets serialised back to DynamoDB on save and looks like a saved
// value on the next read — see the "TechFlow Inc." regression.
const DEFAULT_PROFILE: ProfileData = {
  name: '',
  title: '',
  company: '',
  location: '',
  bio: '',
  interests: [],
  linkedinUrl: '',
};

export function useProfileForm(userProfile: Record<string, unknown> | null) {
  const [profile, setProfile] = useState<ProfileData>(DEFAULT_PROFILE);
  const [newInterest, setNewInterest] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  const handleInputChange = (field: keyof ProfileData, value: string) => {
    setProfile((prev) => ({ ...prev, [field]: value }));
  };

  useEffect(() => {
    // When the user-profile context updates, mirror it into editable fields.
    // Use ?? (nullish coalesce) — an empty string in the API means the user
    // cleared that field, so we shouldn't silently fall back to stale form
    // state via ||.
    try {
      const data = userProfile;
      if (!data) return;
      const firstName = ((data.first_name as string) || '').trim();
      const lastName = ((data.last_name as string) || '').trim();
      const derivedName = [firstName, lastName].filter(Boolean).join(' ').trim();
      setProfile({
        name: derivedName,
        title: (data.headline as string) ?? (data.current_position as string) ?? '',
        company: (data.company as string) ?? '',
        location: (data.location as string) ?? '',
        bio: (data.summary as string) ?? '',
        interests: Array.isArray(data.interests) ? (data.interests as string[]) : [],
        linkedinUrl: (data.profile_url as string) ?? '',
      });
    } catch {
      // Silent fail; do not block profile page if profile isn't initialized yet
    }
  }, [userProfile]);

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

  return {
    profile,
    setProfile,
    newInterest,
    setNewInterest,
    isSaving,
    setIsSaving,
    handleInputChange,
    addInterest,
    removeInterest,
  };
}
