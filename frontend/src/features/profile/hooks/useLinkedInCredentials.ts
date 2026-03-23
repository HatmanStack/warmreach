import { useState, useEffect } from 'react';

export interface LinkedInCredentialsData {
  email: string;
  password: string;
}

export function useLinkedInCredentials(
  ciphertext: string | null | undefined,
  userProfile?: Record<string, unknown> | null
) {
  const [linkedinCredentials, setLinkedinCredentials] = useState<LinkedInCredentialsData>({
    email: '',
    password: '',
  });
  const [showPassword, setShowPassword] = useState(false);
  const [hasStoredCredentials, setHasStoredCredentials] = useState(false);

  useEffect(() => {
    // If we already have ciphertext in context, just show the stored banner
    if (ciphertext) {
      setHasStoredCredentials(true);
    }
  }, [ciphertext]);

  useEffect(() => {
    if (userProfile?.linkedin_credentials) {
      setHasStoredCredentials(true);
    }
  }, [userProfile]);

  const handleLinkedinCredentialsChange = (field: string, value: string) => {
    setLinkedinCredentials((prev) => ({ ...prev, [field]: value }));
  };

  return {
    linkedinCredentials,
    setLinkedinCredentials,
    showPassword,
    setShowPassword,
    hasStoredCredentials,
    setHasStoredCredentials,
    handleLinkedinCredentialsChange,
  };
}
