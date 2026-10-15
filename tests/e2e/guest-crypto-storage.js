'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { chromium } = require('@playwright/test');

const cryptoScript = fs.readFileSync(path.join(__dirname, '../../public/js/guest-crypto.js'));

async function main() {
  const server = http.createServer((req, res) => {
    if (req.url === '/guest-crypto.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-store' });
      return res.end(cryptoScript);
    }
    res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
    res.end(`<!doctype html><script src="/guest-crypto.js"></script><script>
      (async () => {
        try {
          const identity = await GuestCrypto.ensureIdentity('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002');
          let privateExtractable = true;
          try { await crypto.subtle.exportKey('jwk', identity.privateKey); } catch (_) { privateExtractable = false; }
          window.guestCryptoResult = { n: identity.publicKey.n, privateExtractable, persisted: identity.persisted };
        } catch (error) { window.guestCryptoError = error.message; }
      })();
    </script>`);
  });
  let browser;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${address.port}/`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.guestCryptoResult || window.guestCryptoError);
    const first = await page.evaluate(() => ({ result: window.guestCryptoResult, error: window.guestCryptoError, localStorageLength: localStorage.length }));
    if (first.error) throw new Error(first.error);
    if (!first.result || first.result.privateExtractable || first.localStorageLength > 0) {
      throw new Error('Guest private key was exportable or localStorage was used');
    }
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => window.guestCryptoResult || window.guestCryptoError);
    const second = await page.evaluate(() => ({ result: window.guestCryptoResult, error: window.guestCryptoError }));
    if (second.error) throw new Error(second.error);
    if (!second.result || second.result.n !== first.result.n || !second.result.persisted || second.result.privateExtractable) {
      throw new Error('Guest key did not survive browser reload as a non-exportable key');
    }
    const isolated = await page.evaluate(async () => {
      const other = await GuestCrypto.ensureIdentity('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000003');
      const anotherShare = await GuestCrypto.ensureIdentity('00000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-000000000002');
      return { other: other.publicKey.n, anotherShare: anotherShare.publicKey.n, localStorageLength: localStorage.length };
    });
    if (isolated.other === first.result.n || isolated.anotherShare === first.result.n || isolated.other === isolated.anotherShare || isolated.localStorageLength > 0) {
      throw new Error('Guest identity storage crossed a share or guest boundary, or used localStorage');
    }
    console.log('Guest CryptoKey IndexedDB reload, non-exportability and share/guest isolation tests passed');
  } finally {
    await browser?.close();
    if (server.listening) await new Promise(resolve => server.close(resolve));
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
