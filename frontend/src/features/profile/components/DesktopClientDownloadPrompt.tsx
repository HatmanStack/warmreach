import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Apple, Monitor, Terminal, Shield, Download } from 'lucide-react';

interface ClientDownloads {
  mac: string | null;
  win: string | null;
  linux: string | null;
  version: string | null;
}

type Platform = 'mac' | 'win' | 'linux' | 'unknown';

function detectPlatform(): Platform {
  if (typeof navigator === 'undefined') return 'unknown';
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes('mac')) return 'mac';
  if (ua.includes('win')) return 'win';
  if (ua.includes('linux') || ua.includes('cros') || ua.includes('x11')) return 'linux';
  return 'unknown';
}

const PLATFORM_LABEL: Record<Exclude<Platform, 'unknown'>, string> = {
  mac: 'macOS',
  win: 'Windows',
  linux: 'Linux',
};

const PLATFORM_ICON: Record<Exclude<Platform, 'unknown'>, typeof Apple> = {
  mac: Apple,
  win: Monitor,
  linux: Terminal,
};

interface DesktopClientDownloadPromptProps {
  /** Optional callback when user clicks "I already have it installed" */
  onAlreadyInstalled?: () => void;
  /** Hide the "I already have it" link (e.g., during onboarding) */
  hideAlreadyInstalled?: boolean;
}

export function DesktopClientDownloadPrompt({
  onAlreadyInstalled,
  hideAlreadyInstalled = false,
}: DesktopClientDownloadPromptProps) {
  const [platform, setPlatform] = useState<Platform>('unknown');

  useEffect(() => {
    setPlatform(detectPlatform());
  }, []);

  const apiBase = (import.meta.env.VITE_API_GATEWAY_URL ?? '').replace(/\/$/, '');

  const { data, isLoading, error } = useQuery<ClientDownloads>({
    queryKey: ['client-downloads'],
    queryFn: async () => {
      const res = await fetch(`${apiBase}/client-downloads`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    // Cache for 4 minutes — slightly less than the presigned-URL TTL so we
    // never hand out an expired one.
    staleTime: 4 * 60 * 1000,
    retry: 1,
  });

  const platforms: Array<Exclude<Platform, 'unknown'>> = ['mac', 'win', 'linux'];
  const detected = platform !== 'unknown' ? platform : null;
  const others = platforms.filter((p) => p !== detected);

  return (
    <Card className="bg-white/5 backdrop-blur-md border-white/10">
      <CardHeader>
        <CardTitle className="text-white flex items-center">
          <Shield className="h-5 w-5 mr-2" />
          Install the desktop client
        </CardTitle>
        <CardDescription className="text-slate-300">
          LinkedIn credentials live on your device, encrypted with libsodium Sealbox. Install the
          desktop client to enter and store them — they are never transmitted to our servers.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading && <p className="text-slate-400 text-sm">Loading download links…</p>}

        {error && (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-amber-200 text-sm">
            Could not reach the download endpoint. Try again in a moment.
          </div>
        )}

        {data && (
          <>
            {detected && data[detected] && (
              <DownloadButton platform={detected} url={data[detected]!} primary />
            )}

            {detected && !data[detected] && (
              <div className="rounded-lg border border-slate-500/30 bg-slate-500/10 p-3 text-slate-200 text-sm">
                The {PLATFORM_LABEL[detected]} build isn't published yet. Choose another platform
                below or check back soon.
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {others.map((p) =>
                data[p] ? (
                  <DownloadButton key={p} platform={p} url={data[p]!} />
                ) : (
                  <Button key={p} disabled variant="outline" className="justify-start">
                    {iconFor(p)}
                    <span className="ml-2">{PLATFORM_LABEL[p]} (coming soon)</span>
                  </Button>
                )
              )}
            </div>

            {data.version && <p className="text-xs text-slate-400">Version {data.version}</p>}
          </>
        )}

        {!hideAlreadyInstalled && onAlreadyInstalled && (
          <button
            type="button"
            onClick={onAlreadyInstalled}
            className="text-sm text-slate-300 underline-offset-2 hover:underline"
          >
            I already have it installed →
          </button>
        )}
      </CardContent>
    </Card>
  );
}

function iconFor(platform: Exclude<Platform, 'unknown'>) {
  const Icon = PLATFORM_ICON[platform];
  return <Icon className="h-4 w-4" />;
}

function DownloadButton({
  platform,
  url,
  primary = false,
}: {
  platform: Exclude<Platform, 'unknown'>;
  url: string;
  primary?: boolean;
}) {
  return (
    <Button
      asChild
      variant={primary ? 'default' : 'outline'}
      className={primary ? 'w-full' : 'justify-start'}
    >
      <a href={url} download>
        {primary ? <Download className="h-4 w-4 mr-2" /> : iconFor(platform)}
        <span className={primary ? '' : 'ml-2'}>Download for {PLATFORM_LABEL[platform]}</span>
      </a>
    </Button>
  );
}
