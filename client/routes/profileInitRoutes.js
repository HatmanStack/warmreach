import express from 'express';
import ProfileInitController from '../src/domains/profile/controllers/profileInitController.js';
import { logger } from '#utils/logger.js';

const router = express.Router();
const profileInitController = new ProfileInitController();

// Main profile initialization endpoint
router.post('/', async (req, res) => {
  try {
    await profileInitController.performProfileInit(req, res);
  } catch (error) {
    logger.error('Profile initialization route error:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to process profile initialization request',
      timestamp: new Date().toISOString()
    });
  }
});

// Health check endpoint for profile initialization
router.get('/health', async (req, res) => {
  try {
    res.json({
      status: 'healthy',
      service: 'profile-initialization',
      timestamp: new Date().toISOString(),
      version: '1.0.0'
    });
  } catch (error) {
    logger.error('Profile initialization health check error:', error);
    res.status(500).json({
      status: 'unhealthy',
      service: 'profile-initialization',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

export default router;