import { describe, expect, it } from 'vitest';
import { parseRobots, RateLimiter, RobotsGuard, RobotsDeniedError } from '../src/core/net/http';
import { redact } from '../src/core/util/logger';

const parseRobotsForTest = parseRobots;

describe('robots.txt compliance (spec §17)', () => {
  const ogaRobots = `User-agent: *\nCrawl-delay: 10\nDisallow: /search/\nDisallow: /user/login/\nDisallow: /?q=search/\n`;

  it('parses groups, disallows and crawl-delay', () => {
    const groups = parseRobotsForTest(ogaRobots);
    const g = groups.find((x) => x.uas.includes('*'))!;
    expect(g.disallow).toContain('/search/');
    expect(g.crawlDelay).toBe(10_000);
  });

  it('blocks robots-disallowed search paths but allows content pages', async () => {
    const guard = new RobotsGuard(async () => ogaRobots);
    const blocked1 = await guard.isAllowed('https://opengameart.org/search/node/grass', 'UniversalGameAssetHub');
    const blocked2 = await guard.isAllowed('https://opengameart.org/?q=search/node/grass', 'UniversalGameAssetHub');
    const blocked3 = await guard.isAllowed('https://opengameart.org/user/login/now', 'UniversalGameAssetHub');
    const allowed = await guard.isAllowed('https://opengameart.org/content/grass-tile-pack', 'UniversalGameAssetHub');
    expect(blocked1.allowed).toBe(false);
    expect(blocked2.allowed).toBe(false);
    expect(blocked3.allowed).toBe(false);
    expect(allowed.allowed).toBe(true);
  });

  it('missing robots.txt = everything allowed', async () => {
    const guard = new RobotsGuard(async () => null);
    const v = await guard.isAllowed('https://example.com/anything');
    expect(v.allowed).toBe(true);
  });
});

describe('rate limiting', () => {
  it('spaces requests at least minIntervalMs apart', async () => {
    const rl = new RateLimiter({ 'h': { minIntervalMs: 120, maxBurst: 1 } });
    const start = Date.now();
    await rl.acquire('https://h/a');
    await rl.acquire('https://h/b');
    expect(Date.now() - start).toBeGreaterThanOrEqual(110);
  });

  it('per-host independence', async () => {
    const rl = new RateLimiter({ 'a': { minIntervalMs: 200, maxBurst: 1 }, 'b': { minIntervalMs: 200, maxBurst: 1 } });
    const start = Date.now();
    await Promise.all([rl.acquire('https://a/1'), rl.acquire('https://b/1')]);
    expect(Date.now() - start).toBeLessThan(150);
  });
});

describe('credential redaction (spec §14)', () => {
  it('scrubs API keys from logs and errors', () => {
    const secret = 'sk-live-abcdef1234567890';
    const line = redact(`GET https://api.poly.pizza/v1.1/search with X-API-Key: ${secret} failed`);
    expect(line).not.toContain(secret);
    expect(redact(`Authorization: Bearer ${secret}`)).not.toContain(secret);
    expect(redact(`{"token":"${secret}"}`)).not.toContain(secret);
  });
});

describe('RobotsDeniedError surfaces the manual fallback', () => {
  it('carries the refusal reason', () => {
    const e = new RobotsDeniedError('https://x/search/y', 'Disallow: /search/');
    expect(e.message).toContain('robots.txt disallows');
    expect(e.code).toBe('ROBOTS_DENIED');
  });
});
