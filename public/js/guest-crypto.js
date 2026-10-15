/* Guest-only key retention. Private CryptoKeys never become JWK or localStorage data. */
(function (root) {
  'use strict';

  const DB_NAME = 'chatmcp-guest-keys-v1';
  const STORE_NAME = 'identities';
  const STORE_VERSION = 1;

  function keyId(shareId, guestId) {
    return `${shareId}:${guestId}`;
  }

  function indexedDb() {
    const value = root.indexedDB;
    if (!value) throw new Error('This browser cannot securely retain guest keys. Rejoin from a supported browser.');
    return value;
  }

  function openDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDb().open(DB_NAME, STORE_VERSION);
      request.onerror = () => reject(new Error('Guest key storage is unavailable.'));
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE_NAME)) {
          request.result.createObjectStore(STORE_NAME, { keyPath: 'id' });
        }
      };
      request.onsuccess = () => resolve(request.result);
    });
  }

  async function read(id) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readonly');
      const request = transaction.objectStore(STORE_NAME).get(id);
      request.onerror = () => reject(new Error('Guest key storage is unavailable.'));
      request.onsuccess = () => resolve(request.result || null);
      transaction.oncomplete = () => db.close();
      transaction.onerror = () => reject(new Error('Guest key storage is unavailable.'));
    });
  }

  async function write(record) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      transaction.objectStore(STORE_NAME).put(record);
      transaction.oncomplete = () => {
        db.close();
        resolve(record);
      };
      transaction.onerror = () => {
        db.close();
        reject(new Error('Guest key storage is unavailable.'));
      };
    });
  }

  async function remove(id) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      transaction.objectStore(STORE_NAME).delete(id);
      transaction.oncomplete = () => {
        db.close();
        resolve();
      };
      transaction.onerror = () => {
        db.close();
        reject(new Error('Guest key storage is unavailable.'));
      };
    });
  }

  async function create() {
    const pair = await root.crypto.subtle.generateKey({
      name: 'RSA-OAEP',
      modulusLength: 3072,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256'
    }, false, ['wrapKey', 'unwrapKey']);
    const publicKey = await root.crypto.subtle.exportKey('jwk', pair.publicKey);
    return { privateKey: pair.privateKey, publicKey };
  }

  async function ensureIdentity(shareId, guestId) {
    const id = keyId(shareId, guestId);
    const saved = await read(id);
    if (saved) {
      if (!saved.privateKey || !saved.publicKey) throw new Error('Guest key is unavailable. Rejoin this share to recover access.');
      return {
        privateKey: saved.privateKey,
        publicKey: saved.publicKey,
        persisted: true
      };
    }
    const identity = await create();
    await write({
      id,
      shareId,
      guestId,
      publicKey: identity.publicKey,
      privateKey: identity.privateKey
    });
    return {
      ...identity,
      persisted: true
    };
  }

  root.GuestCrypto = {
    ensureIdentity,
    removeIdentity: (shareId, guestId) => remove(keyId(shareId, guestId))
  };
  if (typeof module !== 'undefined') module.exports = root.GuestCrypto;
})(typeof window !== 'undefined' ? window : globalThis);
