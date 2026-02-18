import express from 'express';
import { authorizeHealAndRestore, getPendingAuthorizations, cancelHealAndRestore } from '../src/domains/workflow/services/healAndRestoreService.js';
import { logger } from '#utils/logger.js';

const router = express.Router();

// Get pending heal and restore sessions
router.get('/status', async (req, res) => {
  try {
    const pendingSessions = await getPendingAuthorizations();
    const pendingSession = pendingSessions.length > 0 ? pendingSessions[0] : null;

    res.json({
      success: true,
      data: { pendingSession }
    });
  } catch (error) {
    logger.error('Error getting heal and restore status', { error: error.message });
    res.status(500).json({
      success: false,
      error: 'Failed to get status'
    });
  }
});

// Authorize heal and restore
router.post('/authorize', async (req, res) => {
  try {
    const { sessionId, autoApprove = false } = req.body;

    if (!sessionId) {
      return res.status(400).json({
        success: false,
        error: 'Session ID is required'
      });
    }

    const success = await authorizeHealAndRestore(sessionId, autoApprove);

    if (success) {
      res.json({
        success: true,
        message: 'Heal and restore authorized successfully',
        autoApprove
      });
    } else {
      res.status(404).json({
        success: false,
        error: 'Session not found or already processed'
      });
    }
  } catch (error) {
    logger.error('Error authorizing heal and restore', { error: error.message });
    res.status(500).json({
      success: false,
      error: 'Failed to authorize'
    });
  }
});

// Cancel heal and restore
router.post('/cancel', async (req, res) => {
  try {
    const { sessionId } = req.body;

    if (!sessionId) {
      return res.status(400).json({
        success: false,
        error: 'Session ID is required'
      });
    }

    const success = await cancelHealAndRestore(sessionId);

    if (success) {
      res.json({
        success: true,
        message: 'Heal and restore cancelled successfully'
      });
    } else {
      res.status(404).json({
        success: false,
        error: 'Session not found or already processed'
      });
    }
  } catch (error) {
    logger.error('Error cancelling heal and restore', { error: error.message });
    res.status(500).json({
      success: false,
      error: 'Failed to cancel'
    });
  }
});

export default router;
