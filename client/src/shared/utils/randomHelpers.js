export class RandomHelpers {
  static randomInRange(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  static async randomDelay(minMs = 500, maxMs = 5000) {
    const delay = this.randomInRange(minMs, maxMs);
    return new Promise((resolve) => setTimeout(resolve, delay));
  }

  static shuffleArray(array) {
    const shuffled = [...array];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
  }

  static getRandomUserAgent() {
    const userAgents = [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
    ];
    return userAgents[Math.floor(Math.random() * userAgents.length)];
  }

  /**
   * Generate realistic interaction timing delays based on action type
   * @param {string} actionType - Type of action: 'click', 'type', 'scroll', 'navigate', 'think'
   * @returns {Promise<void>}
   */
  static async humanLikeDelay(actionType = 'default') {
    const delayRanges = {
      click: [200, 800], // Quick click actions
      type: [50, 150], // Between keystrokes
      scroll: [300, 1200], // Scrolling actions
      navigate: [1000, 3000], // Page navigation
      think: [500, 2000], // Thinking/reading pauses
      default: [500, 1500], // General delays
    };

    const [min, max] = delayRanges[actionType] || delayRanges.default;

    // Add some randomness to make delays less predictable
    const baseDelay = this.randomInRange(min, max);
    const variance = Math.random() * 0.3 - 0.15; // ±15% variance
    const finalDelay = Math.max(50, Math.floor(baseDelay * (1 + variance)));

    return new Promise((resolve) => setTimeout(resolve, finalDelay));
  }

  /**
   * Generate variable typing speed with realistic patterns
   * @param {string} text - Text to calculate typing timing for
   * @returns {Array<number>} Array of delays between each character
   */
  static generateTypingPattern(text) {
    const baseSpeed = this.randomInRange(80, 150); // Base WPM equivalent in ms per char
    const delays = [];

    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      let delay = baseSpeed;

      // Adjust delay based on character type
      if (char === ' ') {
        delay *= this.randomInRange(1.2, 2.0); // Longer pause at spaces
      } else if (/[.!?]/.test(char)) {
        delay *= this.randomInRange(1.5, 2.5); // Pause at sentence endings
      } else if (/[,;:]/.test(char)) {
        delay *= this.randomInRange(1.1, 1.8); // Pause at punctuation
      } else if (/[A-Z]/.test(char) && i > 0) {
        delay *= this.randomInRange(1.1, 1.4); // Slight pause before capitals
      } else if (/\d/.test(char)) {
        delay *= this.randomInRange(1.2, 1.6); // Slower for numbers
      }

      // Add random variance (±30%)
      const variance = Math.random() * 0.6 - 0.3;
      delay = Math.max(20, Math.floor(delay * (1 + variance)));

      // Occasional longer pauses (simulate thinking/corrections)
      if (Math.random() < 0.05) {
        // 5% chance
        delay += this.randomInRange(300, 1000);
      }

      delays.push(delay);
    }

    return delays;
  }

  /**
   * Generate random mouse movement coordinates for human-like cursor behavior
   * @param {Object} viewport - Viewport dimensions {width, height}
   * @param {Object} target - Target element bounds {x, y, width, height}
   * @returns {Array<Object>} Array of {x, y} coordinates for mouse path
   */
  static generateMousePath(viewport, target) {
    const startX = this.randomInRange(0, viewport.width);
    const startY = this.randomInRange(0, viewport.height);

    // Target center with some randomness
    const targetX = target.x + target.width / 2 + this.randomInRange(-20, 20);
    const targetY = target.y + target.height / 2 + this.randomInRange(-10, 10);

    const path = [];
    const steps = this.randomInRange(3, 8); // Number of intermediate points

    for (let i = 0; i <= steps; i++) {
      const progress = i / steps;

      // Use bezier-like curve for natural movement
      const curveVariance = Math.sin(progress * Math.PI) * this.randomInRange(-50, 50);

      const x = startX + (targetX - startX) * progress + curveVariance;
      const y = startY + (targetY - startY) * progress + curveVariance * 0.5;

      path.push({ x: Math.round(x), y: Math.round(y) });
    }

    return path;
  }

  /**
   * Generate realistic scrolling behavior
   * @param {number} totalDistance - Total distance to scroll
   * @param {string} direction - 'up' or 'down'
   * @returns {Array<Object>} Array of scroll actions {delta, delay}
   */
  static generateScrollPattern(totalDistance, direction = 'down') {
    const scrollActions = [];
    let remainingDistance = Math.abs(totalDistance);
    const multiplier = direction === 'up' ? -1 : 1;

    while (remainingDistance > 0) {
      // Variable scroll amounts (simulate mouse wheel or trackpad)
      const scrollAmount = Math.min(remainingDistance, this.randomInRange(80, 200));

      // Variable delays between scrolls
      const delay = this.randomInRange(100, 300);

      scrollActions.push({
        delta: scrollAmount * multiplier,
        delay,
      });

      remainingDistance -= scrollAmount;

      // Occasional pause during scrolling
      if (Math.random() < 0.2 && remainingDistance > 0) {
        scrollActions.push({
          delta: 0,
          delay: this.randomInRange(200, 800),
        });
      }
    }

    return scrollActions;
  }

  /**
   * Calculate if a cooling-off period is needed based on recent activity
   * @param {Array<Date>} recentActions - Array of recent action timestamps
   * @param {Object} thresholds - Activity thresholds {actionsPerMinute, actionsPerHour}
   * @returns {Object} {needsCooldown, cooldownDuration, reason}
   */
  static calculateCooldownNeeds(recentActions, thresholds = {}) {
    const now = new Date();
    const oneMinuteAgo = new Date(now.getTime() - 60000);
    const oneHourAgo = new Date(now.getTime() - 3600000);

    const defaultThresholds = {
      actionsPerMinute: 8,
      actionsPerHour: 100,
      ...thresholds,
    };

    // Count recent actions
    const actionsLastMinute = recentActions.filter((action) => action > oneMinuteAgo).length;
    const actionsLastHour = recentActions.filter((action) => action > oneHourAgo).length;

    // Check if cooling-off is needed
    if (actionsLastMinute > defaultThresholds.actionsPerMinute) {
      return {
        needsCooldown: true,
        cooldownDuration: this.randomInRange(30000, 120000), // 30s - 2min
        reason: 'High activity in last minute',
      };
    }

    if (actionsLastHour > defaultThresholds.actionsPerHour) {
      return {
        needsCooldown: true,
        cooldownDuration: this.randomInRange(300000, 900000), // 5-15min
        reason: 'High activity in last hour',
      };
    }

    // Random occasional breaks (simulate natural behavior)
    if (Math.random() < 0.05) {
      // 5% chance
      return {
        needsCooldown: true,
        cooldownDuration: this.randomInRange(10000, 60000), // 10s - 1min
        reason: 'Random natural break',
      };
    }

    return {
      needsCooldown: false,
      cooldownDuration: 0,
      reason: 'No cooldown needed',
    };
  }

  /**
   * Generate realistic reading/scanning time based on content length
   * @param {string} content - Content to calculate reading time for
   * @param {number} wordsPerMinute - Reading speed (default: 200 WPM)
   * @returns {number} Reading time in milliseconds
   */
  static calculateReadingTime(content, wordsPerMinute = 200) {
    const wordCount = content.split(/\s+/).length;
    const baseReadingTime = (wordCount / wordsPerMinute) * 60000; // Convert to ms

    // Add variance for realistic behavior (±40%)
    const variance = Math.random() * 0.8 - 0.4;
    const readingTime = Math.max(1000, baseReadingTime * (1 + variance));

    // Cap maximum reading time for very long content
    return Math.min(readingTime, 30000); // Max 30 seconds
  }

  /**
   * Generate random viewport adjustments (simulate window resizing/zooming)
   * @param {Object} currentViewport - Current viewport {width, height}
   * @returns {Object} New viewport dimensions or null if no change
   */
  static generateViewportAdjustment(currentViewport) {
    // Only occasionally adjust viewport (2% chance)
    if (Math.random() > 0.02) {
      return null;
    }

    const adjustmentTypes = ['resize', 'zoom'];
    const adjustmentType = adjustmentTypes[Math.floor(Math.random() * adjustmentTypes.length)];

    if (adjustmentType === 'resize') {
      // Small window resize
      const widthChange = this.randomInRange(-100, 100);
      const heightChange = this.randomInRange(-50, 50);

      return {
        width: Math.max(800, currentViewport.width + widthChange),
        height: Math.max(600, currentViewport.height + heightChange),
      };
    }

    // Zoom adjustment (simulate Ctrl+scroll)
    const zoomLevels = [0.8, 0.9, 1.0, 1.1, 1.25];
    const currentZoom = 1.0; // Assume default zoom
    const newZoom = zoomLevels[Math.floor(Math.random() * zoomLevels.length)];

    if (newZoom !== currentZoom) {
      return {
        zoom: newZoom,
      };
    }

    return null;
  }
}

export default RandomHelpers;
