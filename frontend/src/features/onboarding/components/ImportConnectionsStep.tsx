import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Users } from 'lucide-react';
import { useOnboarding } from '../hooks/useOnboarding';
import { DEMO_CONNECTIONS } from '../data/demoData';

export const ImportConnectionsStep = () => {
  const { completeStep, skipStep } = useOnboarding();
  const navigate = useNavigate();

  const handleImportNow = async () => {
    await completeStep('import_connections');
    navigate('/dashboard');
  };

  const handleSkip = async () => {
    await skipStep('import_connections');
  };

  const previewConnections = DEMO_CONNECTIONS.slice(0, 4);

  return (
    <div className="space-y-6">
      <div className="text-center space-y-2">
        <div className="mx-auto w-12 h-12 rounded-full bg-purple-100 dark:bg-purple-900/30 flex items-center justify-center">
          <Users className="h-6 w-6 text-purple-600 dark:text-purple-400" />
        </div>
        <h2 className="text-2xl font-bold">Import Your Connections</h2>
        <p className="text-muted-foreground max-w-md mx-auto">
          Importing connections powers all WarmReach features: message generation, network analysis,
          and opportunity discovery.
        </p>
      </div>

      {/* Demo preview */}
      <div className="grid grid-cols-2 gap-3 max-w-lg mx-auto">
        {previewConnections.map((conn) => (
          <div key={conn.id} className="rounded-lg border bg-card p-3 space-y-1">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-full bg-gradient-to-br from-blue-400 to-purple-500 flex items-center justify-center text-xs font-bold text-white">
                {conn.first_name[0]}
                {conn.last_name[0]}
              </div>
              <div className="min-w-0">
                <p className="text-sm font-medium truncate">
                  {conn.first_name} {conn.last_name}
                </p>
                <p className="text-xs text-muted-foreground truncate">{conn.position}</p>
              </div>
            </div>
            <p className="text-xs text-muted-foreground truncate">{conn.company}</p>
          </div>
        ))}
      </div>

      <div className="flex flex-col items-center gap-2">
        <Button onClick={handleImportNow} className="min-w-[200px]" data-testid="onboarding-import">
          Import Now
        </Button>
        <Button
          variant="ghost"
          onClick={handleSkip}
          className="text-sm text-muted-foreground"
          data-testid="onboarding-skip"
        >
          Skip for Now
        </Button>
        <p className="text-xs text-muted-foreground">
          You can always import later from the Dashboard.
        </p>
      </div>
    </div>
  );
};
