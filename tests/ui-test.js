const { chromium } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const BASE_URL = 'http://localhost:3000';
const SCREENSHOT_DIR = '/tmp/claude-1000/-home-onrm-projects-agentsMCPspace-AgentsMCPspace/887c0295-34e2-4762-8a0c-863b1ed10061/scratchpad/screenshots';

// Ensure screenshot directory exists
if (!fs.existsSync(SCREENSHOT_DIR)) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

const testResults = {
  timestamp: new Date().toISOString(),
  baseUrl: BASE_URL,
  tests: [],
  summary: {
    total: 0,
    passed: 0,
    failed: 0
  }
};

function addTest(name, status, details, screenshotPath = null) {
  testResults.tests.push({
    name,
    status,
    details,
    screenshot: screenshotPath
  });
  testResults.summary.total++;
  if (status === 'PASSED') testResults.summary.passed++;
  if (status === 'FAILED') testResults.summary.failed++;
}

async function captureScreenshot(page, name) {
  const filename = `${name.replace(/[^a-z0-9]/gi, '_')}_${Date.now()}.png`;
  const filepath = path.join(SCREENSHOT_DIR, filename);
  await page.screenshot({ path: filepath, fullPage: true });
  return filepath;
}

async function testHomePage(page) {
  console.log('\n=== Testing Home Page ===');
  try {
    await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 10000 });
    const title = await page.title();
    const screenshot = await captureScreenshot(page, 'homepage');

    addTest('Home Page Load', 'PASSED', `Page loaded successfully. Title: "${title}"`, screenshot);
    console.log('✓ Home page loaded successfully');

    // Get page content structure
    const bodyContent = await page.evaluate(() => {
      const headings = Array.from(document.querySelectorAll('h1, h2, h3')).map(h => h.textContent.trim());
      const links = Array.from(document.querySelectorAll('a')).map(a => ({ text: a.textContent.trim(), href: a.href }));
      const buttons = Array.from(document.querySelectorAll('button')).map(b => b.textContent.trim());
      const forms = Array.from(document.querySelectorAll('form')).length;

      return { headings, links: links.slice(0, 20), buttons, formCount: forms };
    });

    addTest('Page Structure Analysis', 'INFO', JSON.stringify(bodyContent, null, 2));
    console.log('✓ Page structure analyzed');

    return bodyContent;
  } catch (error) {
    addTest('Home Page Load', 'FAILED', error.message);
    console.log('✗ Home page test failed:', error.message);
    return null;
  }
}

async function testNavigation(page, structure) {
  console.log('\n=== Testing Navigation ===');

  if (!structure || !structure.links || structure.links.length === 0) {
    addTest('Navigation Test', 'SKIPPED', 'No links found to test');
    return;
  }

  // Test first few internal links
  const internalLinks = structure.links.filter(link =>
    link.href.startsWith(BASE_URL) || link.href.startsWith('/')
  ).slice(0, 5);

  for (const link of internalLinks) {
    try {
      const linkText = link.text || 'Empty link';
      console.log(`Testing link: ${linkText}`);

      await page.goto(link.href.startsWith('/') ? BASE_URL + link.href : link.href, {
        waitUntil: 'networkidle',
        timeout: 10000
      });

      const screenshot = await captureScreenshot(page, `nav_${linkText}`);
      addTest(`Navigation: ${linkText}`, 'PASSED', `Successfully navigated to ${link.href}`, screenshot);
      console.log(`✓ Navigated to: ${linkText}`);

      await page.waitForTimeout(500); // Brief pause between navigations
    } catch (error) {
      addTest(`Navigation: ${link.text}`, 'FAILED', error.message);
      console.log(`✗ Navigation failed for: ${link.text}`);
    }
  }
}

async function testForms(page) {
  console.log('\n=== Testing Forms ===');

  try {
    await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 10000 });

    const forms = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('form')).map((form, idx) => {
        const inputs = Array.from(form.querySelectorAll('input, textarea, select')).map(input => ({
          type: input.type || input.tagName.toLowerCase(),
          name: input.name,
          id: input.id,
          placeholder: input.placeholder,
          required: input.required
        }));

        return {
          index: idx,
          action: form.action,
          method: form.method,
          inputs
        };
      });
    });

    if (forms.length === 0) {
      addTest('Form Detection', 'INFO', 'No forms found on home page');
      console.log('ℹ No forms found');
    } else {
      addTest('Form Detection', 'PASSED', `Found ${forms.length} form(s):\n${JSON.stringify(forms, null, 2)}`);
      console.log(`✓ Found ${forms.length} form(s)`);
    }
  } catch (error) {
    addTest('Form Detection', 'FAILED', error.message);
    console.log('✗ Form detection failed:', error.message);
  }
}

async function testResponsiveness(page) {
  console.log('\n=== Testing Responsiveness ===');

  const viewports = [
    { name: 'Mobile', width: 375, height: 667 },
    { name: 'Tablet', width: 768, height: 1024 },
    { name: 'Desktop', width: 1920, height: 1080 }
  ];

  for (const viewport of viewports) {
    try {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 10000 });

      const screenshot = await captureScreenshot(page, `responsive_${viewport.name}`);
      addTest(`Responsive: ${viewport.name}`, 'PASSED',
        `Page renders at ${viewport.width}x${viewport.height}`, screenshot);
      console.log(`✓ ${viewport.name} viewport (${viewport.width}x${viewport.height})`);
    } catch (error) {
      addTest(`Responsive: ${viewport.name}`, 'FAILED', error.message);
      console.log(`✗ ${viewport.name} viewport failed`);
    }
  }
}

async function testAccessibility(page) {
  console.log('\n=== Testing Accessibility ===');

  try {
    await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 10000 });

    const a11yIssues = await page.evaluate(() => {
      const issues = [];

      // Check for images without alt text
      const imagesWithoutAlt = Array.from(document.querySelectorAll('img:not([alt])')).length;
      if (imagesWithoutAlt > 0) {
        issues.push(`${imagesWithoutAlt} image(s) missing alt text`);
      }

      // Check for form inputs without labels
      const inputsWithoutLabels = Array.from(document.querySelectorAll('input:not([aria-label]):not([aria-labelledby])')).filter(input => {
        const id = input.id;
        return !id || !document.querySelector(`label[for="${id}"]`);
      }).length;
      if (inputsWithoutLabels > 0) {
        issues.push(`${inputsWithoutLabels} input(s) without associated labels`);
      }

      // Check for buttons without text
      const emptyButtons = Array.from(document.querySelectorAll('button')).filter(btn =>
        !btn.textContent.trim() && !btn.getAttribute('aria-label')
      ).length;
      if (emptyButtons > 0) {
        issues.push(`${emptyButtons} button(s) without text or aria-label`);
      }

      return issues;
    });

    if (a11yIssues.length === 0) {
      addTest('Accessibility Check', 'PASSED', 'No obvious accessibility issues found');
      console.log('✓ No obvious accessibility issues');
    } else {
      addTest('Accessibility Check', 'WARNING', `Issues found:\n${a11yIssues.join('\n')}`);
      console.log('⚠ Accessibility issues found:', a11yIssues);
    }
  } catch (error) {
    addTest('Accessibility Check', 'FAILED', error.message);
    console.log('✗ Accessibility check failed:', error.message);
  }
}

async function testPerformance(page) {
  console.log('\n=== Testing Performance ===');

  try {
    const startTime = Date.now();
    await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 10000 });
    const loadTime = Date.now() - startTime;

    const metrics = await page.evaluate(() => {
      const perf = window.performance;
      const timing = perf.timing;

      return {
        domContentLoaded: timing.domContentLoadedEventEnd - timing.navigationStart,
        loadComplete: timing.loadEventEnd - timing.navigationStart,
        resources: perf.getEntriesByType('resource').length
      };
    });

    addTest('Performance', 'INFO',
      `Load time: ${loadTime}ms\n` +
      `DOM Content Loaded: ${metrics.domContentLoaded}ms\n` +
      `Load Complete: ${metrics.loadComplete}ms\n` +
      `Resources loaded: ${metrics.resources}`
    );
    console.log(`✓ Performance metrics captured (${loadTime}ms)`);
  } catch (error) {
    addTest('Performance', 'FAILED', error.message);
    console.log('✗ Performance test failed:', error.message);
  }
}

async function testConsoleErrors(page) {
  console.log('\n=== Testing Console Errors ===');

  const consoleMessages = {
    errors: [],
    warnings: [],
    logs: []
  };

  page.on('console', msg => {
    const type = msg.type();
    const text = msg.text();

    if (type === 'error') consoleMessages.errors.push(text);
    else if (type === 'warning') consoleMessages.warnings.push(text);
    else consoleMessages.logs.push(text);
  });

  page.on('pageerror', error => {
    consoleMessages.errors.push(`Page Error: ${error.message}`);
  });

  try {
    await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 10000 });
    await page.waitForTimeout(2000); // Wait for any async errors

    if (consoleMessages.errors.length === 0) {
      addTest('Console Errors', 'PASSED', 'No console errors detected');
      console.log('✓ No console errors');
    } else {
      addTest('Console Errors', 'WARNING',
        `${consoleMessages.errors.length} error(s) found:\n${consoleMessages.errors.join('\n')}`);
      console.log(`⚠ ${consoleMessages.errors.length} console error(s) found`);
    }

    if (consoleMessages.warnings.length > 0) {
      addTest('Console Warnings', 'INFO',
        `${consoleMessages.warnings.length} warning(s):\n${consoleMessages.warnings.slice(0, 10).join('\n')}`);
      console.log(`ℹ ${consoleMessages.warnings.length} console warning(s)`);
    }
  } catch (error) {
    addTest('Console Errors', 'FAILED', error.message);
    console.log('✗ Console error check failed:', error.message);
  }
}

async function runAllTests() {
  console.log('Starting Playwright UI Test Suite...');
  console.log(`Testing: ${BASE_URL}`);

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Playwright Test'
  });

  const page = await context.newPage();

  try {
    // Run all tests
    await testConsoleErrors(page);
    const structure = await testHomePage(page);
    await testNavigation(page, structure);
    await testForms(page);
    await testResponsiveness(page);
    await testAccessibility(page);
    await testPerformance(page);

    // Save results
    const reportPath = path.join(SCREENSHOT_DIR, 'test-report.json');
    fs.writeFileSync(reportPath, JSON.stringify(testResults, null, 2));

    console.log('\n' + '='.repeat(60));
    console.log('TEST SUMMARY');
    console.log('='.repeat(60));
    console.log(`Total Tests: ${testResults.summary.total}`);
    console.log(`Passed: ${testResults.summary.passed}`);
    console.log(`Failed: ${testResults.summary.failed}`);
    console.log(`\nReport saved to: ${reportPath}`);
    console.log(`Screenshots saved to: ${SCREENSHOT_DIR}`);
    console.log('='.repeat(60));

  } catch (error) {
    console.error('Test suite failed:', error);
  } finally {
    await browser.close();
  }
}

runAllTests().catch(console.error);
