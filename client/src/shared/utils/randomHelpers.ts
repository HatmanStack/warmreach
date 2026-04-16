export const USER_AGENT_POOL: string[] = [
  // Windows 10/11
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',

  // macOS (13-15)
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',

  // Linux
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
];

interface Viewport {
  width: number;
  height: number;
}

interface TargetBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Point {
  x: number;
  y: number;
}

interface ScrollAction {
  delta: number;
  delay: number;
}

interface CooldownResult {
  needsCooldown: boolean;
  cooldownDuration: number;
  reason: string;
}

interface CooldownThresholds {
  actionsPerMinute?: number;
  actionsPerHour?: number;
}

type ActionType = 'click' | 'type' | 'scroll' | 'navigate' | 'think' | 'default';

export class RandomHelpers {
  static randomInRange(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  static randomFloat(min: number, max: number): number {
    return Math.random() * (max - min) + min;
  }

  static async randomDelay(minMs = 500, maxMs = 5000): Promise<void> {
    const delay = this.randomInRange(minMs, maxMs);
    return new Promise((resolve) => setTimeout(resolve, delay));
  }

  static shuffleArray<T>(array: T[]): T[] {
    const shuffled = [...array];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
    }
    return shuffled;
  }

  static getRandomUserAgent(): string {
    return USER_AGENT_POOL[Math.floor(Math.random() * USER_AGENT_POOL.length)]!;
  }

  static async humanLikeDelay(actionType: ActionType = 'default'): Promise<void> {
    const delayRanges: Record<ActionType, [number, number]> = {
      click: [200, 800],
      type: [50, 150],
      scroll: [300, 1200],
      navigate: [1000, 3000],
      think: [500, 2000],
      default: [500, 1500],
    };

    const [min, max] = delayRanges[actionType] || delayRanges.default;

    const baseDelay = this.randomInRange(min, max);
    const variance = Math.random() * 0.3 - 0.15;
    const finalDelay = Math.max(50, Math.floor(baseDelay * (1 + variance)));

    return new Promise((resolve) => setTimeout(resolve, finalDelay));
  }

  static generateTypingPattern(text: string): number[] {
    const baseSpeed = this.randomInRange(80, 150);
    const delays: number[] = [];

    for (let i = 0; i < text.length; i++) {
      const char = text[i]!;
      let delay = baseSpeed;

      if (char === ' ') {
        delay *= this.randomFloat(1.2, 2.0);
      } else if (/[.!?]/.test(char)) {
        delay *= this.randomFloat(1.5, 2.5);
      } else if (/[,;:]/.test(char)) {
        delay *= this.randomFloat(1.1, 1.8);
      } else if (/[A-Z]/.test(char) && i > 0) {
        delay *= this.randomFloat(1.1, 1.4);
      } else if (/\d/.test(char)) {
        delay *= this.randomFloat(1.2, 1.6);
      }

      const variance = Math.random() * 0.6 - 0.3;
      delay = Math.max(20, Math.floor(delay * (1 + variance)));

      if (Math.random() < 0.05) {
        delay += this.randomInRange(300, 1000);
      }

      delays.push(delay);
    }

    return delays;
  }

  static generateMousePath(viewport: Viewport, target: TargetBounds): Point[] {
    const startX = this.randomInRange(0, viewport.width);
    const startY = this.randomInRange(0, viewport.height);

    const targetX = target.x + target.width / 2 + this.randomInRange(-20, 20);
    const targetY = target.y + target.height / 2 + this.randomInRange(-10, 10);

    const path: Point[] = [];
    const steps = this.randomInRange(3, 8);

    for (let i = 0; i <= steps; i++) {
      const progress = i / steps;
      const curveVariance = Math.sin(progress * Math.PI) * this.randomInRange(-50, 50);
      const x = startX + (targetX - startX) * progress + curveVariance;
      const y = startY + (targetY - startY) * progress + curveVariance * 0.5;
      path.push({ x: Math.round(x), y: Math.round(y) });
    }

    return path;
  }

  static generateScrollPattern(
    totalDistance: number,
    direction: 'up' | 'down' = 'down'
  ): ScrollAction[] {
    const scrollActions: ScrollAction[] = [];
    let remainingDistance = Math.abs(totalDistance);
    const multiplier = direction === 'up' ? -1 : 1;

    while (remainingDistance > 0) {
      const scrollAmount = Math.min(remainingDistance, this.randomInRange(80, 200));
      const delay = this.randomInRange(100, 300);

      scrollActions.push({
        delta: scrollAmount * multiplier,
        delay,
      });

      remainingDistance -= scrollAmount;

      if (Math.random() < 0.2 && remainingDistance > 0) {
        scrollActions.push({
          delta: 0,
          delay: this.randomInRange(200, 800),
        });
      }
    }

    return scrollActions;
  }

  static calculateCooldownNeeds(
    recentActions: Date[],
    thresholds: CooldownThresholds = {}
  ): CooldownResult {
    const now = new Date();
    const oneMinuteAgo = new Date(now.getTime() - 60000);
    const oneHourAgo = new Date(now.getTime() - 3600000);

    const defaultThresholds = {
      actionsPerMinute: 8,
      actionsPerHour: 100,
      ...thresholds,
    };

    const actionsLastMinute = recentActions.filter((action) => action > oneMinuteAgo).length;
    const actionsLastHour = recentActions.filter((action) => action > oneHourAgo).length;

    if (actionsLastMinute > defaultThresholds.actionsPerMinute) {
      return {
        needsCooldown: true,
        cooldownDuration: this.randomInRange(30000, 120000),
        reason: 'High activity in last minute',
      };
    }

    if (actionsLastHour > defaultThresholds.actionsPerHour) {
      return {
        needsCooldown: true,
        cooldownDuration: this.randomInRange(300000, 900000),
        reason: 'High activity in last hour',
      };
    }

    if (Math.random() < 0.05) {
      return {
        needsCooldown: true,
        cooldownDuration: this.randomInRange(10000, 60000),
        reason: 'Random natural break',
      };
    }

    return {
      needsCooldown: false,
      cooldownDuration: 0,
      reason: 'No cooldown needed',
    };
  }

  static calculateReadingTime(content: string, wordsPerMinute = 200): number {
    const wordCount = content.split(/\s+/).length;
    const baseReadingTime = (wordCount / wordsPerMinute) * 60000;
    const variance = Math.random() * 0.8 - 0.4;
    const readingTime = Math.max(1000, baseReadingTime * (1 + variance));
    return Math.min(readingTime, 30000);
  }

  static generateViewportAdjustment(
    currentViewport: Viewport
  ): { width?: number; height?: number; zoom?: number } | null {
    if (Math.random() > 0.02) {
      return null;
    }

    const adjustmentTypes = ['resize', 'zoom'] as const;
    const adjustmentType = adjustmentTypes[Math.floor(Math.random() * adjustmentTypes.length)];

    if (adjustmentType === 'resize') {
      const widthChange = this.randomInRange(-100, 100);
      const heightChange = this.randomInRange(-50, 50);

      return {
        width: Math.max(800, currentViewport.width + widthChange),
        height: Math.max(600, currentViewport.height + heightChange),
      };
    }

    const zoomLevels = [0.8, 0.9, 1.0, 1.1, 1.25];
    const currentZoom = 1.0;
    const newZoom = zoomLevels[Math.floor(Math.random() * zoomLevels.length)];

    if (newZoom !== currentZoom) {
      return { zoom: newZoom };
    }

    return null;
  }
}
