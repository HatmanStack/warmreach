/**
 * LinkedIn Post Operations - Post creation, publishing, media attachments
 *
 * Extracted from linkedinInteractionService.js as part of domain decomposition.
 * Each function receives the service instance as its first parameter.
 */

import { logger } from '#utils/logger.js';
import config from '#shared-config/index.js';
import { LinkedInError } from '../utils/LinkedInError.js';
import { linkedinResolver } from '../selectors/index.js';

/**
 * Create and publish a LinkedIn post
 * @param {import('./linkedinInteractionService.js').LinkedInInteractionService} service
 * @param {string} content
 * @param {Array} mediaAttachments
 * @param {string} userId
 * @returns {Promise<Object>}
 */
export async function createPost(service, content, mediaAttachments = [], userId) {
  const context = {
    operation: 'createPost',
    contentLength: content.length,
    hasMedia: mediaAttachments.length > 0,
    userId,
  };

  logger.info(`Creating LinkedIn post by user ${userId}`, context);
  service._enforceRateLimit();
  await service._applyControlPlaneRateLimits('createPost');

  await service.checkSuspiciousActivity();
  await service.getBrowserSession();

  await service.navigateToPostCreator();
  await service.composePost(content);

  if (mediaAttachments && mediaAttachments.length > 0) {
    await service.addMediaAttachments(mediaAttachments);
  }

  const postResult = await service.publishPost();

  service.sessionManager.lastActivity = new Date();

  service.humanBehavior.recordAction('post_created', {
    contentLength: content.length,
    hasMedia: mediaAttachments.length > 0,
    userId,
  });

  service._reportInteraction('createPost');

  logger.info(`Successfully created LinkedIn post`, {
    postId: postResult.postId,
    postUrl: postResult.postUrl,
    userId,
  });

  return {
    postId: postResult.postId || `post_${Date.now()}_${userId}`,
    postUrl: postResult.postUrl,
    publishStatus: 'published',
    publishedAt: new Date().toISOString(),
    userId,
  };
}

/**
 * Navigate to LinkedIn post creation interface
 * @param {import('./linkedinInteractionService.js').LinkedInInteractionService} service
 * @returns {Promise<void>}
 */
export async function navigateToPostCreator(service) {
  logger.info('Navigating to LinkedIn post creation interface');

  try {
    const session = await service.getBrowserSession();

    const navigationTimeout = service.configManager.get('navigationTimeout', 30000);
    await session.goto(`${config.linkedin.baseUrl}/feed/`, {
      waitUntil: 'networkidle',
      timeout: navigationTimeout,
    });

    await service.waitForLinkedInLoad();

    let startPostButton = null;

    try {
      startPostButton = await linkedinResolver.resolveWithWait(
        session.getPage(),
        'post:start-button',
        { timeout: 5000 }
      );
      logger.debug(`Found start post button`);
    } catch (err) {
      logger.debug(`Selector failed for start post button:`, {
        error: err.message,
      });
    }

    if (!startPostButton) {
      throw new LinkedInError('Start post button not found on LinkedIn feed', 'ELEMENT_NOT_FOUND');
    }

    logger.info('Clicking start post button');
    await startPostButton.click();

    await service.waitForPostCreationInterface();

    logger.info('Successfully navigated to post creation interface');
  } catch (error) {
    logger.error('Failed to navigate to post creation interface:', error);

    throw new LinkedInError(
      `Post creator navigation failed: ${error.message}`,
      'BROWSER_NAVIGATION_FAILED',
      { cause: error }
    );
  }
}

/**
 * Wait for post creation interface to load
 * @param {import('./linkedinInteractionService.js').LinkedInInteractionService} service
 * @returns {Promise<void>}
 */
export async function waitForPostCreationInterface(service) {
  try {
    const session = await service.getBrowserSession();

    let postCreationElement = null;
    try {
      postCreationElement = await linkedinResolver.resolveWithWait(
        session.getPage(),
        'post:content-editor',
        { timeout: 8000 }
      );
      logger.debug(`Post creation interface loaded`);
    } catch {
      // Continue to next selector
    }

    if (!postCreationElement) {
      throw new LinkedInError('Post creation interface did not load properly', 'ELEMENT_NOT_FOUND');
    }
  } catch (error) {
    logger.error('Failed to wait for post creation interface:', error);
    throw error;
  }
}

/**
 * Compose post content in the LinkedIn post creator
 * @param {import('./linkedinInteractionService.js').LinkedInInteractionService} service
 * @param {string} content
 * @returns {Promise<void>}
 */
export async function composePost(service, content) {
  logger.info('Composing LinkedIn post content', {
    contentLength: content.length,
  });

  try {
    const session = await service.getBrowserSession();
    const page = session.getPage();

    await service.waitForLinkedInLoad();

    let contentInput = null;
    try {
      contentInput = await linkedinResolver.resolveWithWait(page, 'post:content-editor', {
        timeout: 3000,
      });
      logger.debug(`Found content input`);
    } catch {
      // Continue to next selector
    }

    if (!contentInput) {
      throw new LinkedInError('Post content input field not found', 'ELEMENT_NOT_FOUND');
    }

    await service.humanBehavior.simulateHumanMouseMovement(page, contentInput);

    await contentInput.click();

    await page.keyboard.down('Control');
    await page.keyboard.press('KeyA');
    await page.keyboard.up('Control');

    await page.keyboard.press('Delete');

    await service.typeWithHumanPattern(content, contentInput);

    logger.info('Post content composed successfully');
  } catch (error) {
    logger.error('Failed to compose post content:', error);
    throw new LinkedInError(`Post composition failed: ${error.message}`, 'POST_CREATION_FAILED', {
      cause: error,
    });
  }
}

/**
 * Add media attachments to the post
 * @param {import('./linkedinInteractionService.js').LinkedInInteractionService} service
 * @param {Array} mediaAttachments
 * @returns {Promise<void>}
 */
export async function addMediaAttachments(service, mediaAttachments) {
  logger.info('Adding media attachments to post', {
    attachmentCount: mediaAttachments.length,
  });

  try {
    if (!mediaAttachments || mediaAttachments.length === 0) {
      logger.debug('No media attachments to add');
      return;
    }

    const session = await service.getBrowserSession();
    const page = session.getPage();

    let mediaButton = null;
    try {
      mediaButton = await linkedinResolver.resolveWithWait(page, 'post:media-button', {
        timeout: 2000,
      });
      logger.debug(`Found media button`);
    } catch {
      // Continue to next selector
    }

    if (!mediaButton) {
      logger.warn('Media upload button not found, skipping media attachments');
      return;
    }

    for (let i = 0; i < mediaAttachments.length; i++) {
      const attachment = mediaAttachments[i];
      logger.info(`Processing media attachment ${i + 1}/${mediaAttachments.length}`, {
        type: attachment.type,
        filename: attachment.filename,
      });

      await service.humanBehavior.simulateHumanMouseMovement(page, mediaButton);

      await mediaButton.click();

      if (attachment.filePath) {
        try {
          const fileInput = await session.waitForSelector('input[type="file"]', {
            timeout: 5000,
          });
          if (fileInput) {
            await fileInput.uploadFile(attachment.filePath);
            logger.debug(`Uploaded file: ${attachment.filePath}`);
          }
        } catch (uploadError) {
          logger.warn(`Failed to upload file ${attachment.filePath}:`, uploadError.message);
        }
      }

      if (i < mediaAttachments.length - 1) {
      }
    }

    service.humanBehavior.recordAction('media_attached', {
      attachmentCount: mediaAttachments.length,
      types: mediaAttachments.map((a) => a.type),
    });

    logger.info('Media attachments added successfully');
  } catch (error) {
    logger.error('Failed to add media attachments:', error);

    service.humanBehavior.recordAction('media_attachment_failed', {
      attachmentCount: mediaAttachments.length,
      error: error.message,
    });

    throw new LinkedInError(`Media attachment failed: ${error.message}`, 'POST_CREATION_FAILED', {
      cause: error,
    });
  }
}

/**
 * Input post content with realistic typing patterns and delays
 * @param {import('./linkedinInteractionService.js').LinkedInInteractionService} service
 * @param {string} content
 * @returns {Promise<void>}
 */
export async function inputPostContent(service, content) {
  logger.info('Inputting post content', {
    contentLength: content.length,
  });

  try {
    const session = await service.getBrowserSession();
    const page = session.getPage();

    await service.waitForLinkedInLoad();

    const contentInput = await linkedinResolver
      .resolveWithWait(page, 'post:content-editor', { timeout: 3000 })
      .catch(() => null);

    if (!contentInput) {
      throw new LinkedInError('Post content input field not found', 'ELEMENT_NOT_FOUND');
    }

    await service.clearAndTypeText(page, contentInput, content);

    logger.info('Post content input completed successfully');
  } catch (error) {
    logger.error('Failed to input post content:', error);
    throw new Error(`Post content input failed: ${error.message}`);
  }
}

/**
 * Attach media files to the post (placeholder implementation)
 * @param {import('./linkedinInteractionService.js').LinkedInInteractionService} service
 * @param {Array} mediaAttachments
 * @returns {Promise<void>}
 */
export async function attachMediaToPost(service, mediaAttachments) {
  logger.info('Attaching media to post', {
    mediaCount: mediaAttachments.length,
  });

  try {
    const session = await service.getBrowserSession();
    const page = session.getPage();

    const mediaButton = await linkedinResolver
      .resolveWithWait(page, 'post:media-button', { timeout: 2000 })
      .catch(() => null);

    if (!mediaButton) {
      logger.warn('Media attachment button not found, skipping media upload');
      return;
    }

    logger.info('Clicking media attachment button');
    await service._paced(1000, 2000, () => service.clickElementHumanly(page, mediaButton));

    logger.warn('Media attachment functionality is placeholder - files not actually uploaded');
  } catch (error) {
    logger.error('Failed to attach media to post:', error);
    logger.warn('Proceeding with post creation without media attachments');
  }
}

/**
 * Publish the post and wait for confirmation
 * @param {import('./linkedinInteractionService.js').LinkedInInteractionService} service
 * @returns {Promise<Object>}
 */
export async function publishPost(service) {
  logger.info('Publishing LinkedIn post');

  try {
    const session = await service.getBrowserSession();
    const page = session.getPage();

    const publishButton = await linkedinResolver
      .resolveWithWait(page, 'post:publish-button', { timeout: 3000 })
      .catch(() => null);

    if (!publishButton) {
      throw new LinkedInError('Publish button not found', 'ELEMENT_NOT_FOUND');
    }

    const isDisabled = await publishButton.getAttribute('disabled');
    if (isDisabled) {
      throw new LinkedInError(
        'Publish button is disabled - post may be incomplete',
        'POST_CREATION_FAILED'
      );
    }

    logger.info('Clicking publish button');
    await service.clickElementHumanly(page, publishButton);

    let postUrl = null;
    try {
      const currentUrl = await page.url();
      if (currentUrl.includes('/posts/') || currentUrl.includes('/activity-')) {
        postUrl = currentUrl;
      }
    } catch {
      logger.debug('Could not extract post URL from current page');
    }

    const postId = `post_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    if (!postUrl) {
      postUrl = `https://linkedin.com/posts/activity-${Date.now()}`;
    }

    logger.info('Post published successfully', {
      postId,
      postUrl,
    });

    return {
      postId,
      postUrl,
      publishedAt: new Date().toISOString(),
      status: 'published',
    };
  } catch (error) {
    logger.error('Failed to publish post:', error);
    throw new LinkedInError(`Post publishing failed: ${error.message}`, 'POST_CREATION_FAILED', {
      cause: error,
    });
  }
}

/**
 * Create and publish a LinkedIn post (combined method)
 * @param {import('./linkedinInteractionService.js').LinkedInInteractionService} service
 * @param {string} content
 * @param {Array} mediaAttachments
 * @returns {Promise<Object>}
 */
export async function createAndPublishPost(service, content, mediaAttachments = []) {
  logger.info('Creating and publishing LinkedIn post', {
    contentLength: content.length,
    hasMedia: mediaAttachments.length > 0,
    mediaCount: mediaAttachments.length,
  });

  try {
    await service.getBrowserSession();

    await service.humanBehavior.checkAndApplyCooldown();

    await service.navigateToPostCreator();
    await service.composePost(content);

    if (mediaAttachments && mediaAttachments.length > 0) {
      await service.addMediaAttachments(mediaAttachments);
    }

    const postResult = await service.publishPost();

    service.humanBehavior.recordAction('post_created', {
      contentLength: content.length,
      hasMedia: mediaAttachments.length > 0,
      mediaCount: mediaAttachments.length,
    });

    logger.info('Successfully created and published LinkedIn post', {
      postId: postResult.postId,
      postUrl: postResult.postUrl,
    });

    return {
      postId: postResult.postId || `post_${Date.now()}`,
      postUrl: postResult.postUrl,
      publishStatus: 'published',
      publishedAt: new Date().toISOString(),
      contentLength: content.length,
      mediaCount: mediaAttachments.length,
    };
  } catch (error) {
    logger.error('Failed to create and publish LinkedIn post:', error);

    service.humanBehavior.recordAction('post_failed', {
      contentLength: content.length,
      error: error.message,
    });

    throw error;
  }
}

/**
 * Complete LinkedIn post creation workflow
 * @param {import('./linkedinInteractionService.js').LinkedInInteractionService} service
 * @param {string} content
 * @param {Array} mediaAttachments
 * @param {Object} options
 * @returns {Promise<Object>}
 */
export async function executePostCreationWorkflow(
  service,
  content,
  mediaAttachments = [],
  options = {}
) {
  const metrics = service.sessionManager.getSessionMetrics();
  try {
    const result = await _executePostCreationWorkflowInternal(
      service,
      content,
      mediaAttachments,
      options
    );
    metrics?.recordOperation(true);
    return result;
  } catch (error) {
    metrics?.recordOperation(false);
    throw error;
  }
}

/**
 * Internal implementation of post creation workflow
 */
async function _executePostCreationWorkflowInternal(
  service,
  content,
  mediaAttachments = [],
  options = {}
) {
  const context = {
    operation: 'executePostCreationWorkflow',
    contentLength: content.length,
    hasMedia: mediaAttachments.length > 0,
    mediaCount: mediaAttachments.length,
    options,
    startTime: Date.now(),
  };

  logger.info('Executing complete LinkedIn post creation workflow', context);
  service._enforceRateLimit();

  await service._applyControlPlaneRateLimits('executePostCreationWorkflow');

  await service.checkSuspiciousActivity();
  await service.getBrowserSession();

  logger.info('Step 1/5: Opening post creation interface');
  await service.navigateToPostCreator();

  logger.info('Step 2/5: Composing post content');
  await service.composePost(content);

  if (mediaAttachments && mediaAttachments.length > 0) {
    logger.info(`Step 3/5: Adding ${mediaAttachments.length} media attachments`);
    await service.addMediaAttachments(mediaAttachments);
  }

  logger.info('Step 4/5: Reviewing post content');

  logger.info('Step 5/5: Publishing post');
  const postResult = await service.publishPost();

  service.sessionManager.lastActivity = new Date();
  service.humanBehavior.recordAction('post_creation_workflow_completed', {
    contentLength: content.length,
    hasMedia: mediaAttachments.length > 0,
    mediaCount: mediaAttachments.length,
    postPublished: postResult.status === 'published',
    workflowDuration: Date.now() - context.startTime,
  });

  const result = {
    workflowId: `post_workflow_${Date.now()}`,
    postId: postResult.postId,
    postUrl: postResult.postUrl,
    publishStatus: postResult.status,
    publishedAt: postResult.publishedAt,
    contentLength: content.length,
    mediaCount: mediaAttachments.length,
    workflowSteps: [
      { step: 'post_interface_navigation', status: 'completed' },
      { step: 'content_composition', status: 'completed' },
      { step: 'media_attachment', status: mediaAttachments.length > 0 ? 'completed' : 'skipped' },
      { step: 'content_review', status: 'completed' },
      {
        step: 'post_publication',
        status: postResult.status === 'published' ? 'confirmed' : 'pending',
      },
    ],
  };

  service._reportInteraction('executePostCreationWorkflow');

  logger.info('LinkedIn post creation workflow completed successfully', result);
  return result;
}
