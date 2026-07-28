import express from 'express';
import { LinkedInInteractionController } from '../src/domains/linkedin/controllers/linkedinInteractionController.js';
import { logger } from '#utils/logger.js';

const router = express.Router();

/**
 * A caught value is `unknown`; surface a message without assuming it is an Error.
 * @param {unknown} error
 * @returns {string}
 */
const getErrorMessage = (error) => (error instanceof Error ? error.message : String(error));
const linkedInInteractionController = new LinkedInInteractionController();

// JWT Authentication middleware
/**
 * Parameters are annotated individually rather than typing the whole arrow as
 * `RequestHandler`: @types/express declares that call signature returning
 * `unknown`, so a void middleware trips TS2355/TS7030 under noImplicitReturns.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 * @returns {void}
 */
const authenticateJWT = (req, res, next) => {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.startsWith('Bearer ') 
    ? authHeader.substring(7) 
    : null;

  if (!token) {
    logger.warn('LinkedIn interaction request without JWT token', {
      path: req.path,
      method: req.method,
      ip: req.ip
    });
    res.status(401).json({
      success: false,
      error: {
        code: 'MISSING_TOKEN',
        message: 'Missing or invalid Authorization header',
        details: 'JWT token is required for LinkedIn interactions'
      },
      timestamp: new Date().toISOString()
    });
  } else {
    // Store token in request for controller use (see src/types/express.d.ts)
    req.jwtToken = token;
    next();
  }
};

// Apply JWT authentication to all routes
router.use(authenticateJWT);

// Send message endpoint
router.post('/send-message', async (req, res) => {
  try {
    await linkedInInteractionController.sendMessage(req, res);
  } catch (error) {
    logger.error('Send message route error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Internal server error during message sending',
        details: process.env.NODE_ENV === 'development' ? getErrorMessage(error) : 'Something went wrong'
      },
      timestamp: new Date().toISOString()
    });
  }
});

// Add connection endpoint
router.post('/add-connection', async (req, res) => {
  try {
    await linkedInInteractionController.addConnection(req, res);
  } catch (error) {
    logger.error('Add connection route error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Internal server error during connection request',
        details: process.env.NODE_ENV === 'development' ? getErrorMessage(error) : 'Something went wrong'
      },
      timestamp: new Date().toISOString()
    });
  }
});

// Create post endpoint
router.post('/create-post', async (req, res) => {
  try {
    await linkedInInteractionController.createPost(req, res);
  } catch (error) {
    logger.error('Create post route error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Internal server error during post creation',
        details: process.env.NODE_ENV === 'development' ? getErrorMessage(error) : 'Something went wrong'
      },
      timestamp: new Date().toISOString()
    });
  }
});

// Follow profile endpoint
router.post('/follow-profile', async (req, res) => {
  try {
    await linkedInInteractionController.followProfile(req, res);
  } catch (error) {
    logger.error('Follow profile route error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Internal server error during profile follow',
        details: process.env.NODE_ENV === 'development' ? getErrorMessage(error) : 'Something went wrong'
      },
      timestamp: new Date().toISOString()
    });
  }
});

// Session status endpoint
router.get('/session-status', async (req, res) => {
  try {
    await linkedInInteractionController.getSessionStatus(req, res);
  } catch (error) {
    logger.error('Session status route error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Internal server error during session status check',
        details: process.env.NODE_ENV === 'development' ? getErrorMessage(error) : 'Something went wrong'
      },
      timestamp: new Date().toISOString()
    });
  }
});

export default router;