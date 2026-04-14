import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Download, FileJson, FileSpreadsheet } from 'lucide-react';

interface ExportDataProps {
  onExportCsv: () => void;
  onExportJson?: () => void;
  hasConnections: boolean;
}

export function ExportData({ onExportCsv, onExportJson, hasConnections }: ExportDataProps) {
  return (
    <Card className="bg-white/5 backdrop-blur-md border-white/10" data-testid="export-section">
      <CardHeader>
        <CardTitle className="text-white flex items-center">
          <Download className="h-5 w-5 mr-2" />
          Export Data
        </CardTitle>
        <CardDescription className="text-slate-300">
          Download your connections as CSV or JSON.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex gap-3">
          <Button
            data-testid="export-csv-button"
            onClick={onExportCsv}
            disabled={!hasConnections}
            variant="outline"
            className="border-white/20 text-white hover:bg-white/10 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <FileSpreadsheet className="h-4 w-4 mr-2" />
            Export CSV
          </Button>
          <Button
            data-testid="export-json-button"
            onClick={onExportJson}
            disabled={!hasConnections || !onExportJson}
            variant="outline"
            className="border-white/20 text-white hover:bg-white/10 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <FileJson className="h-4 w-4 mr-2" />
            Export JSON
          </Button>
        </div>
        {!hasConnections && (
          <p className="text-slate-400 text-sm mt-2">
            Visit the Dashboard first to load your connections.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
