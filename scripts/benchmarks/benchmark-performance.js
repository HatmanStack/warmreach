#!/usr/bin/env node

/**
 * Performance Benchmarking Script
 *
 * Tests performance of WarmReach components:
 * - Text extraction from profiles
 * - S3 upload performance
 * - Search API response time
 * - Lambda cold start metrics
 *
 * Usage:
 *   node scripts/benchmark-performance.js
 *   node scripts/benchmark-performance.js --test extraction
 *   node scripts/benchmark-performance.js --test s3-upload
 *   node scripts/benchmark-performance.js --test search-api
 */

import { performance } from 'perf_hooks';
import fs from 'fs/promises';

// Configuration
const config = {
  apiGatewayUrl: process.env.VITE_API_GATEWAY_URL || 'https://your-api-gateway-url.com',
  jwtToken: process.env.JWT_TOKEN || '',
  s3Bucket: process.env.S3_PROFILE_TEXT_BUCKET_NAME || 'linkedin-adv-search-screenshots',
  iterations: parseInt(process.env.BENCHMARK_ITERATIONS || '10'),
  outputFile: 'Migration/docs/performance-benchmark-results.md',
};

// Test queries for search API benchmarking
const testQueries = [
  'software engineer',
  'product manager machine learning',
  'data scientist python',
  'frontend developer react',
  'backend engineer aws',
  'devops kubernetes',
  'mobile developer ios',
  'full stack javascript',
  'ai researcher nlp',
  'security engineer cloud',
];

/**
 * Utility: Measure execution time of async function
 */
async function measureTime(fn, label) {
  const start = performance.now();
  const result = await fn();
  const duration = performance.now() - start;

  console.log(`${label}: ${duration.toFixed(2)}ms`);

  return {
    duration,
    result,
  };
}

/**
 * Utility: Calculate statistics
 */
function calculateStats(measurements) {
  const sorted = measurements.sort((a, b) => a - b);
  return {
    min: sorted[0],
    max: sorted[sorted.length - 1],
    avg: measurements.reduce((a, b) => a + b, 0) / measurements.length,
    median: sorted[Math.floor(sorted.length / 2)],
    p95: sorted[Math.floor(sorted.length * 0.95)],
    p99: sorted[Math.floor(sorted.length * 0.99)],
  };
}

/**
 * Helper: fetch JSON with timeout and auth
 */
async function fetchJSON(url, { method = 'POST', body, timeout = 5000 } = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${config.jwtToken}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    return await response.json();
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Test 1: Search API Response Time
 */
async function benchmarkSearchApi() {
  console.log('\n=== Benchmarking Search API ===\n');

  if (!config.jwtToken) {
    console.warn('JWT_TOKEN not set. Skipping search API benchmark.');
    console.warn('   Set JWT_TOKEN environment variable to test with authentication.');
    return null;
  }

  const measurements = [];
  const results = [];

  for (let i = 0; i < Math.min(testQueries.length, config.iterations); i++) {
    const query = testQueries[i];

    try {
      const { duration, result } = await measureTime(async () => {
        return await fetchJSON(`${config.apiGatewayUrl}/search`, {
          body: { query, limit: 10, offset: 0 },
          timeout: 5000,
        });
      }, `Query ${i + 1}: "${query}"`);

      measurements.push(duration);
      results.push({
        query,
        duration,
        success: true,
        statusCode: 200,
      });
    } catch (error) {
      console.error(`Query ${i + 1} failed:`, error.message);
      results.push({
        query,
        duration: null,
        success: false,
        error: error.message,
      });
    }

    // Small delay between requests
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const stats = calculateStats(measurements);

  console.log('\nSearch API Statistics:');
  console.log(`   Average: ${stats.avg.toFixed(2)}ms`);
  console.log(`   Median:  ${stats.median.toFixed(2)}ms`);
  console.log(`   Min:     ${stats.min.toFixed(2)}ms`);
  console.log(`   Max:     ${stats.max.toFixed(2)}ms`);
  console.log(`   P95:     ${stats.p95.toFixed(2)}ms`);
  console.log(`   P99:     ${stats.p99.toFixed(2)}ms`);
  console.log(`   Success: ${results.filter((r) => r.success).length}/${results.length}`);

  const targetMet = stats.avg < 500;
  console.log(`   Target (<500ms): ${targetMet ? 'MET' : 'NOT MET'}`);

  return {
    type: 'search-api',
    stats,
    results,
    targetMet,
    target: 500,
  };
}

/**
 * Test 2: Lambda Cold Start
 */
async function benchmarkLambdaColdStart() {
  console.log('\n=== Benchmarking Lambda Cold Start ===\n');

  if (!config.jwtToken) {
    console.warn('JWT_TOKEN not set. Skipping Lambda cold start benchmark.');
    return null;
  }

  console.log('This test requires Lambda to be idle for 10+ minutes.');
  console.log(
    '   First request will measure cold start, subsequent requests measure warm execution.'
  );

  const measurements = {
    coldStart: null,
    warmExecutions: [],
  };

  try {
    // First request (potentially cold start)
    const { duration: coldDuration } = await measureTime(async () => {
      return await fetchJSON(`${config.apiGatewayUrl}/search`, {
        body: { query: 'cold start test', limit: 1 },
        timeout: 10000,
      });
    }, 'Cold Start Request');

    measurements.coldStart = coldDuration;

    // Wait a bit
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Warm execution requests
    for (let i = 0; i < 5; i++) {
      const { duration } = await measureTime(async () => {
        return await fetchJSON(`${config.apiGatewayUrl}/search`, {
          body: { query: `warm test ${i}`, limit: 1 },
          timeout: 5000,
        });
      }, `Warm Request ${i + 1}`);

      measurements.warmExecutions.push(duration);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    const warmStats = calculateStats(measurements.warmExecutions);
    const overhead = measurements.coldStart - warmStats.avg;

    console.log('\nLambda Cold Start Statistics:');
    console.log(`   Cold Start: ${measurements.coldStart.toFixed(2)}ms`);
    console.log(`   Warm Avg:   ${warmStats.avg.toFixed(2)}ms`);
    console.log(`   Overhead:   ${overhead.toFixed(2)}ms`);
    console.log(`   Target (<3000ms): ${measurements.coldStart < 3000 ? 'MET' : 'NOT MET'}`);

    return {
      type: 'lambda-cold-start',
      coldStart: measurements.coldStart,
      warmStats,
      overhead,
      targetMet: measurements.coldStart < 3000,
      target: 3000,
    };
  } catch (error) {
    console.error('Lambda cold start test failed:', error.message);
    return null;
  }
}

/**
 * Test 3: Mock Text Extraction (simulated)
 */
async function benchmarkTextExtraction() {
  console.log('\n=== Benchmarking Text Extraction (Simulated) ===\n');
  console.log('This is a simulated test. Run actual test with Puppeteer backend running.');
  console.log('   Expected range: 2000-5000ms per profile');

  return {
    type: 'text-extraction',
    simulated: true,
    expectedRange: '2000-5000ms',
    target: 5000,
    note: 'Requires Puppeteer backend and LinkedIn credentials. Run manually with e2e tests.',
  };
}

/**
 * Test 4: Mock S3 Upload (simulated)
 */
async function benchmarkS3Upload() {
  console.log('\n=== Benchmarking S3 Upload (Simulated) ===\n');
  console.log('This is a simulated test. Run actual test with profile scraping workflow.');
  console.log('   Expected range: 500-2000ms per file');

  return {
    type: 's3-upload',
    simulated: true,
    expectedRange: '500-2000ms',
    target: 2000,
    note: 'Requires AWS credentials and profile data. Run manually with e2e tests.',
  };
}

/**
 * Generate summary report
 */
function generateSummaryReport(results) {
  console.log('\n' + '='.repeat(60));
  console.log('PERFORMANCE BENCHMARK SUMMARY');
  console.log('='.repeat(60) + '\n');

  const timestamp = new Date().toISOString();
  console.log(`Date: ${timestamp}`);
  console.log(`API Gateway URL: ${config.apiGatewayUrl}`);
  console.log(`Iterations: ${config.iterations}\n`);

  console.log('Results:');
  results.forEach((result, index) => {
    if (!result) return;

    console.log(`\n${index + 1}. ${result.type.toUpperCase()}`);

    if (result.simulated) {
      console.log(`   Status: Simulated (${result.expectedRange})`);
      console.log(`   Note: ${result.note}`);
    } else if (result.stats) {
      console.log(`   Average: ${result.stats.avg.toFixed(2)}ms`);
      console.log(`   Target: <${result.target}ms`);
      console.log(`   Status: ${result.targetMet ? 'MET' : 'NOT MET'}`);
    } else if (result.coldStart) {
      console.log(`   Cold Start: ${result.coldStart.toFixed(2)}ms`);
      console.log(`   Warm Avg: ${result.warmStats.avg.toFixed(2)}ms`);
      console.log(`   Target: <${result.target}ms`);
      console.log(`   Status: ${result.targetMet ? 'MET' : 'NOT MET'}`);
    }
  });

  console.log('\n' + '='.repeat(60) + '\n');

  return {
    timestamp,
    config: {
      apiGatewayUrl: config.apiGatewayUrl,
      iterations: config.iterations,
    },
    results: results.filter((r) => r !== null),
  };
}

/**
 * Update markdown documentation with results
 */
async function updateDocumentation(summary) {
  console.log('Updating documentation with benchmark results...');

  try {
    const doc = await fs.readFile(config.outputFile, 'utf-8');

    // Update the test date
    let updated = doc.replace(/\*\*Test Date:\*\* .*/, `**Test Date:** ${summary.timestamp}`);

    // Update search API results if available
    const searchResult = summary.results.find((r) => r.type === 'search-api');
    if (searchResult && searchResult.stats) {
      updated = updated.replace(
        /- \*\*Average Response Time:\*\* _TBD_/,
        `- **Average Response Time:** ${searchResult.stats.avg.toFixed(2)}ms`
      );
      updated = updated.replace(
        /- \*\*Min Response Time:\*\* _TBD_/,
        `- **Min Response Time:** ${searchResult.stats.min.toFixed(2)}ms`
      );
      updated = updated.replace(
        /- \*\*Max Response Time:\*\* _TBD_/,
        `- **Max Response Time:** ${searchResult.stats.max.toFixed(2)}ms`
      );
      updated = updated.replace(
        /- \*\*Target Met:\*\* Pending/,
        `- **Target Met:** ${searchResult.targetMet ? 'Yes' : 'No'} (Target: < 500ms)`
      );
    }

    // Update Lambda cold start results if available
    const lambdaResult = summary.results.find((r) => r.type === 'lambda-cold-start');
    if (lambdaResult && lambdaResult.coldStart) {
      updated = updated.replace(
        /- \*\*Cold Start Time:\*\* _TBD_/,
        `- **Cold Start Time:** ${lambdaResult.coldStart.toFixed(2)}ms`
      );
      updated = updated.replace(
        /- \*\*Warm Execution Time:\*\* _TBD_/,
        `- **Warm Execution Time:** ${lambdaResult.warmStats.avg.toFixed(2)}ms`
      );
      updated = updated.replace(
        /- \*\*Cold Start Overhead:\*\* _TBD_/,
        `- **Cold Start Overhead:** ${lambdaResult.overhead.toFixed(2)}ms`
      );
    }

    // Update overall status
    updated = updated.replace(
      /\*\*Status:\*\* Ready for live testing after deployment/,
      `**Status:** Benchmark completed on ${new Date(summary.timestamp).toLocaleDateString()}`
    );

    await fs.writeFile(config.outputFile, updated);
    console.log(`Updated ${config.outputFile}`);
  } catch (error) {
    console.error('Failed to update documentation:', error.message);
  }
}

/**
 * Main execution
 */
async function main() {
  const args = process.argv.slice(2);
  const testFilter = args.find((arg) => arg.startsWith('--test='))?.split('=')[1];

  console.log('WarmReach - Performance Benchmark');
  console.log('='.repeat(60));

  // Check configuration
  if (!config.apiGatewayUrl || config.apiGatewayUrl.includes('your-api-gateway')) {
    console.warn('\nVITE_API_GATEWAY_URL not configured.');
    console.warn('   Set this environment variable to test against deployed infrastructure.\n');
  }

  const results = [];

  // Run tests based on filter
  if (!testFilter || testFilter === 'search-api') {
    results.push(await benchmarkSearchApi());
  }

  if (!testFilter || testFilter === 'lambda') {
    results.push(await benchmarkLambdaColdStart());
  }

  if (!testFilter || testFilter === 'extraction') {
    results.push(await benchmarkTextExtraction());
  }

  if (!testFilter || testFilter === 's3-upload') {
    results.push(await benchmarkS3Upload());
  }

  // Generate summary
  const summary = generateSummaryReport(results);

  // Update documentation
  await updateDocumentation(summary);

  // Save JSON results
  const jsonOutput = 'Migration/docs/performance-benchmark-data.json';
  await fs.writeFile(jsonOutput, JSON.stringify(summary, null, 2));
  console.log(`Detailed results saved to ${jsonOutput}`);

  console.log('\nBenchmark complete.\n');
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error('Benchmark failed:', error);
    process.exit(1);
  });
}

export { benchmarkSearchApi, benchmarkLambdaColdStart, benchmarkTextExtraction, benchmarkS3Upload };
