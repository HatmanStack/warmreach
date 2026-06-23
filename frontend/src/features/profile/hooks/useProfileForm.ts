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
      // When the profile context clears (sign-out, account switch),
      // wipe local form state too — otherwise the previous user's
      // values would linger in the inputs.
      if (!data) {
        setProfile(DEFAULT_PROFILE);
        return;
      }
      // Defensive coercion: type assertions don't run at runtime, so a
      // non-string value coming from the API would otherwise propagate
      // and break .trim() / string concat downstream. typeof guards
      // ensure we either get a string or an empty string.
      const asString = (v: unknown): string => (typeof v === 'string' ? v : '');
      const firstName = asString(data.first_name).trim();
      const lastName = asString(data.last_name).trim();
      const derivedName = [firstName, lastName].filter(Boolean).join(' ').trim();
      const interests: string[] = Array.isArray(data.interests)
        ? (data.interests as unknown[]).map((i) => (typeof i === 'string' ? i : String(i)))
        : [];
      // ?? (nullish) for the title fallback so an intentionally empty
      // headline isn't silently overwritten by current_position. With
      // ||, '' would fall through; with ??, only undefined/null does.
      const title =
        data.headline !== undefined && data.headline !== null
          ? asString(data.headline)
          : asString(data.current_position);
      setProfile({
        name: derivedName,
        title,
        company: asString(data.company),
        location: asString(data.location),
        bio: asString(data.summary),
        interests,
        linkedinUrl: asString(data.profile_url),
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
