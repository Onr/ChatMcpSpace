/* Shared by browsers and Node 22 runners. No account key leaves the client. */
(function (root) {
  'use strict';

  const api = {
    b64(bytes) {
      const b = new Uint8Array(bytes);
      if (typeof Buffer !== 'undefined') return Buffer.from(b).toString('base64');
      let s = '';
      for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode(...b.subarray(i, i + 8192));
      return btoa(s);
    },
    bytes(text) {
      if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(text, 'base64'));
      return Uint8Array.from(atob(text), c => c.charCodeAt(0));
    },
    async aes(raw) {
      return crypto.subtle.importKey('raw', typeof raw === 'string' ? api.bytes(raw) : raw, 'AES-GCM', true, ['encrypt', 'decrypt']);
    },
    async newKey() {
      return api.aes(crypto.getRandomValues(new Uint8Array(32)));
    },
    async encrypt(key, value, context) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const data = await crypto.subtle.encrypt({
        name: 'AES-GCM',
        iv,
        additionalData: new TextEncoder().encode(context)
      }, key, new TextEncoder().encode(JSON.stringify(value)));
      return {
        v: 1,
        iv: api.b64(iv),
        data: api.b64(data)
      };
    },
    async decrypt(key, envelope, context) {
      if (envelope.v !== 1) throw new Error('Unsupported encryption format');
      const bytes = await crypto.subtle.decrypt({
        name: 'AES-GCM',
        iv: api.bytes(envelope.iv),
        additionalData: new TextEncoder().encode(context)
      }, key, api.bytes(envelope.data));
      return JSON.parse(new TextDecoder().decode(bytes));
    },
    async identity(accountKey, principal) {
      const pair = await crypto.subtle.generateKey({
        name: 'RSA-OAEP',
        modulusLength: 3072,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256'
      }, true, ['wrapKey', 'unwrapKey']);
      const publicKey = await crypto.subtle.exportKey('jwk', pair.publicKey);
      const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
      return {
        publicKey,
        privateKey: await api.encrypt(accountKey, privateJwk, principal)
      };
    },
    async privateKey(accountKey, envelope, principal) {
      const jwk = await api.decrypt(accountKey, envelope, principal);
      return crypto.subtle.importKey('jwk', jwk, {
        name: 'RSA-OAEP',
        hash: 'SHA-256'
      }, false, ['unwrapKey']);
    },
    async wrap(key, publicJwk) {
      const recipient = await crypto.subtle.importKey('jwk', publicJwk, {
        name: 'RSA-OAEP',
        hash: 'SHA-256'
      }, false, ['wrapKey']);
      return api.b64(await crypto.subtle.wrapKey('raw', key, recipient, 'RSA-OAEP'));
    },
    async unwrap(wrapped, privateKey) {
      return crypto.subtle.unwrapKey('raw', api.bytes(wrapped), privateKey, 'RSA-OAEP', 'AES-GCM', true, ['encrypt', 'decrypt']);
    }
  };
  if (typeof module !== 'undefined') module.exports = api;else root.SharedCrypto = api;
})(typeof window !== 'undefined' ? window : globalThis);
