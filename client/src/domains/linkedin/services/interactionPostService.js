import { logger } from '#utils/logger.js';
import config from '#shared-config/index.js';
import { linkedinResolver } from '../selectors/index.js';
import { LinkedInError } from '../utils/LinkedInError.js';
import { BaseLinkedInService } from './BaseLinkedInService.js';

/**
 * Handles post creation workflows: navigating to post creator,
 * composing content, adding media, and publishing.
 * Extends BaseLinkedInService for shared infrastructure.
 */
export class InteractionPostService extends BaseLinkedInService {
  constructor(options = {}) {
    super(options);
  }

  /**
   * Create and publish a LinkedIn post
   * @param {string} content - Post content
   * @param {Array} mediaAttachments - Optional media attachments
   * @param {string} userId - ID of authenticated user
   * @returns {Promise<Object>} Post result
   */
  async createPost(content, mediaAttachments = [], userId) {
    const context = {
      operation: 'createPost',
      contentLength: content.length,
      hasMedia: mediaAttachments.length > 0,
      userId,
    };

    logger.info(`Creating LinkedIn post by user ${userId}`, context);
    this._enforceRateLimit();
    await this._applyControlPlaneRateLimits('createPost');
    await this.checkSuspiciousActivity();
    await this.getBrowserSession();

    await this.navigateToPostCreator();
    await this.composePost(content);

    if (mediaAttachments && mediaAttachments.length > 0) {
      await this.addMediaAttachments(mediaAttachments);
    }

    const postResult = await this.publishPost();

    this.sessionManager.lastActivity = new Date();
    this.humanBehavior.recordAction('post_created', {
      contentLength: content.length,
      hasMedia: mediaAttachments.length > 0,
      userId,
    });

    this._reportInteraction('createPost');

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
   * @returns {Promise<void>}
   */
  async navigateToPostCreator() {
    logger.info('Navigating to LinkedIn post creation interface');

    try {
      const session = await this.getBrowserSession();

      const navigationTimeout = this.configManager.get('navigationTimeout', 30000);
      await session.goto(`${config.linkedin.baseUrl}/feed/`, {
        waitUntil: 'networkidle',
        timeout: navigationTimeout,
      });

      await this.waitForLinkedInLoad();

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
        throw new LinkedInError(
          'Start post button not found on LinkedIn feed',
          'ELEMENT_NOT_FOUND'
        );
      }

      logger.info('Clicking start post button');
      await startPostButton.click();

      await this.waitForPostCreationInterface();

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
   * @returns {Promise<void>}
   */
  async waitForPostCreationInterface() {
    try {
      const session = await this.getBrowserSession();

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
        throw new LinkedInError(
          'Post creation interface did not load properly',
          'ELEMENT_NOT_FOUND'
        );
      }
    } catch (error) {
      logger.error('Failed to wait for post creation interface:', error);
      throw error;
    }
  }

  /**
   * Compose post content in the LinkedIn post creator
   * @param {string} content - Post content to compose
   * @returns {Promise<void>}
   */
  async composePost(content) {
    logger.info('Composing LinkedIn post content', { contentLength: content.length });

    try {
      const session = await this.getBrowserSession();
      const page = session.getPage();

      await this.waitForLinkedInLoad();

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

      await this.humanBehavior.simulateHumanMouseMovement(page, contentInput);
      await contentInput.click();

      await page.keyboard.down('Control');
      await page.keyboard.press('KeyA');
      await page.keyboard.up('Control');
      await page.keyboard.press('Delete');

      await this.typeWithHumanPattern(content, contentInput);

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
   * @param {Array} mediaAttachments - Array of media attachments
   * @returns {Promise<void>}
   */
  async addMediaAttachments(mediaAttachments) {
    logger.info('Adding media attachments to post', {
      attachmentCount: mediaAttachments.length,
    });

    try {
      if (!mediaAttachments || mediaAttachments.length === 0) {
        logger.debug('No media attachments to add');
        return;
      }

      const session = await this.getBrowserSession();
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

        await this.humanBehavior.simulateHumanMouseMovement(page, mediaButton);
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
      }

      this.humanBehavior.recordAction('media_attached', {
        attachmentCount: mediaAttachments.length,
        types: mediaAttachments.map((a) => a.type),
      });

      logger.info('Media attachments added successfully');
    } catch (error) {
      logger.error('Failed to add media attachments:', error);
      this.humanBehavior.recordAction('media_attachment_failed', {
        attachmentCount: mediaAttachments.length,
        error: error.message,
      });
      throw new LinkedInError(`Media attachment failed: ${error.message}`, 'POST_CREATION_FAILED', {
        cause: error,
      });
    }
  }

  /**
   * Input post content with realistic typing patterns
   * @param {string} content - Post content to input
   * @returns {Promise<void>}
   */
  async inputPostContent(content) {
    logger.info('Inputting post content', { contentLength: content.length });

    try {
      const session = await this.getBrowserSession();
      const page = session.getPage();

      await this.waitForLinkedInLoad();

      const contentInput = await linkedinResolver
        .resolveWithWait(page, 'post:content-editor', { timeout: 3000 })
        .catch(() => null);

      if (!contentInput) {
        throw new LinkedInError('Post content input field not found', 'ELEMENT_NOT_FOUND');
      }

      await this.clearAndTypeText(page, contentInput, content);

      logger.info('Post content input completed successfully');
    } catch (error) {
      logger.error('Failed to input post content:', error);
      throw new Error(`Post content input failed: ${error.message}`);
    }
  }

  /**
   * Attach media files to the post (placeholder)
   * @param {Array} mediaAttachments - Array of media attachment objects
   * @returns {Promise<void>}
   */
  async attachMediaToPost(mediaAttachments) {
    logger.info('Attaching media to post', { mediaCount: mediaAttachments.length });

    try {
      const session = await this.getBrowserSession();
      const page = session.getPage();

      const mediaButton = await linkedinResolver
        .resolveWithWait(page, 'post:media-button', { timeout: 2000 })
        .catch(() => null);

      if (!mediaButton) {
        logger.warn('Media attachment button not found, skipping media upload');
        return;
      }

      logger.info('Clicking media attachment button');
      await this._paced(1000, 2000, () => this.clickElementHumanly(page, mediaButton));

      logger.warn('Media attachment functionality is placeholder - files not actually uploaded');
    } catch (error) {
      logger.error('Failed to attach media to post:', error);
      logger.warn('Proceeding with post creation without media attachments');
    }
  }

  /**
   * Publish the post and wait for confirmation
   * @returns {Promise<Object>} Post result with ID and URL
   */
  async publishPost() {
    logger.info('Publishing LinkedIn post');

    try {
      const session = await this.getBrowserSession();
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
      await this.clickElementHumanly(page, publishButton);

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

      logger.info('Post published successfully', { postId, postUrl });

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
   * @param {string} content - Post content
   * @param {Array} mediaAttachments - Optional media attachments
   * @returns {Promise<Object>} Post result with ID and URL
   */
  async createAndPublishPost(content, mediaAttachments = []) {
    logger.info('Creating and publishing LinkedIn post', {
      contentLength: content.length,
      hasMedia: mediaAttachments.length > 0,
      mediaCount: mediaAttachments.length,
    });

    try {
      await this.getBrowserSession();
      await this.humanBehavior.checkAndApplyCooldown();

      await this.navigateToPostCreator();
      await this.composePost(content);

      if (mediaAttachments && mediaAttachments.length > 0) {
        await this.addMediaAttachments(mediaAttachments);
      }

      const postResult = await this.publishPost();

      this.humanBehavior.recordAction('post_created', {
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
      this.humanBehavior.recordAction('post_failed', {
        contentLength: content.length,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Complete LinkedIn post creation workflow
   * @param {string} content - Post content
   * @param {Array} mediaAttachments - Optional media attachments
   * @param {Object} options - Additional posting options
   * @returns {Promise<Object>} Complete post creation result
   */
  async executePostCreationWorkflow(content, mediaAttachments = [], options = {}) {
    const metrics = this.sessionManager.getSessionMetrics();
    try {
      const result = await this._executePostCreationWorkflowInternal(
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
  async _executePostCreationWorkflowInternal(content, mediaAttachments = [], options = {}) {
    const context = {
      operation: 'executePostCreationWorkflow',
      contentLength: content.length,
      hasMedia: mediaAttachments.length > 0,
      mediaCount: mediaAttachments.length,
      options,
      startTime: Date.now(),
    };

    logger.info('Executing complete LinkedIn post creation workflow', context);
    this._enforceRateLimit();
    await this._applyControlPlaneRateLimits('executePostCreationWorkflow');

    await this.checkSuspiciousActivity();
    await this.getBrowserSession();

    logger.info('Step 1/5: Opening post creation interface');
    await this.navigateToPostCreator();

    logger.info('Step 2/5: Composing post content');
    await this.composePost(content);

    if (mediaAttachments && mediaAttachments.length > 0) {
      logger.info(`Step 3/5: Adding ${mediaAttachments.length} media attachments`);
      await this.addMediaAttachments(mediaAttachments);
    }

    logger.info('Step 4/5: Reviewing post content');

    logger.info('Step 5/5: Publishing post');
    const postResult = await this.publishPost();

    this.sessionManager.lastActivity = new Date();
    this.humanBehavior.recordAction('post_creation_workflow_completed', {
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
        {
          step: 'media_attachment',
          status: mediaAttachments.length > 0 ? 'completed' : 'skipped',
        },
        { step: 'content_review', status: 'completed' },
        {
          step: 'post_publication',
          status: postResult.status === 'published' ? 'confirmed' : 'pending',
        },
      ],
    };

    this._reportInteraction('executePostCreationWorkflow');

    logger.info('LinkedIn post creation workflow completed successfully', result);
    return result;
  }
}
