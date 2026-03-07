import { describe, it, expect, vi, beforeEach } from 'vitest';
import { lambdaApiService } from './lambdaApiService';
import { connectionsApiService } from './connectionsApiService';
import { messagesApiService } from './messagesApiService';
import { profileApiService } from './profileApiService';
import { analyticsApiService } from './analyticsApiService';
import { httpClient } from '@/shared/utils/httpClient';

vi.mock('./connectionsApiService');
vi.mock('./messagesApiService');
vi.mock('./profileApiService');
vi.mock('./analyticsApiService');
vi.mock('@/shared/utils/httpClient');

describe('LambdaApiService (Facade)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should delegate getConnectionsByStatus', async () => {
    await lambdaApiService.getConnectionsByStatus('ally');
    expect(connectionsApiService.getConnectionsByStatus).toHaveBeenCalledWith('ally');
  });

  it('should delegate updateConnectionStatus', async () => {
    await lambdaApiService.updateConnectionStatus('c1', 'ally');
    expect(connectionsApiService.updateConnectionStatus).toHaveBeenCalledWith(
      'c1',
      'ally',
      undefined
    );
  });

  it('should delegate getMessageHistory', async () => {
    await lambdaApiService.getMessageHistory('c1');
    expect(messagesApiService.getMessageHistory).toHaveBeenCalledWith('c1');
  });

  it('should delegate getUserProfile', async () => {
    await lambdaApiService.getUserProfile();
    expect(profileApiService.getUserProfile).toHaveBeenCalled();
  });

  it('should delegate updateUserProfile', async () => {
    const profile = { firstName: 'J' };
    await lambdaApiService.updateUserProfile(profile);
    expect(profileApiService.updateUserProfile).toHaveBeenCalledWith(profile);
  });

  it('should delegate createUserProfile', async () => {
    const profile = { email: 'e' };
    await lambdaApiService.createUserProfile(profile);
    expect(profileApiService.createUserProfile).toHaveBeenCalledWith(profile);
  });

  it('should delegate getMessagingInsights', async () => {
    await lambdaApiService.getMessagingInsights(true);
    expect(analyticsApiService.getMessagingInsights).toHaveBeenCalledWith(true);
  });

  it('should delegate analyzeMessagePatterns', async () => {
    await lambdaApiService.analyzeMessagePatterns({}, []);
    expect(analyticsApiService.analyzeMessagePatterns).toHaveBeenCalledWith({}, []);
  });

  it('should delegate storeMessageInsights', async () => {
    await lambdaApiService.storeMessageInsights(['i']);
    expect(analyticsApiService.storeMessageInsights).toHaveBeenCalledWith(['i']);
  });

  it('should delegate getAnalyticsDashboard', async () => {
    await lambdaApiService.getAnalyticsDashboard(7);
    expect(analyticsApiService.getAnalyticsDashboard).toHaveBeenCalledWith(7);
  });

  it('should delegate computeRelationshipScores', async () => {
    await lambdaApiService.computeRelationshipScores();
    expect(connectionsApiService.computeRelationshipScores).toHaveBeenCalled();
  });

  it('should delegate makeRequest to httpClient', async () => {
    await lambdaApiService.makeRequest('e', 'op', { p: 1 });
    expect(httpClient.makeRequest).toHaveBeenCalledWith('e', 'op', { p: 1 }, {});
  });
});
