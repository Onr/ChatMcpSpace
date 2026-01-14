/**
 * Client-Side Encryption/Decryption Module
 * Handles end-to-end encryption of messages in the browser
 */

// Encryption parameters (must match server-side)
const ENCRYPTION_PARAMS = {
  algorithm: 'AES-GCM',
  keyLength: 256,
  ivLength: 12,
  tagLength: 128,
  pbkdf2Iterations: 100000,
  pbkdf2Hash: 'SHA-256'
};

/**
 * Derive encryption key from password and salt using PBKDF2
 * @param {string} password - User's plaintext password
 * @param {string} saltBase64 - Base64 encoded salt
 * @returns {Promise<CryptoKey>} Derived encryption key
 */
async function deriveKey(password, saltBase64) {
  const encoder = new TextEncoder();
  const passwordBuffer = encoder.encode(password);
  const saltBuffer = Uint8Array.from(atob(saltBase64), c => c.charCodeAt(0));

  // Import password as key material
  const keyMaterial = await window.crypto.subtle.importKey(
    'raw',
    passwordBuffer,
    'PBKDF2',
    false,
    ['deriveBits', 'deriveKey']
  );

  // Derive encryption key
  const key = await window.crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: saltBuffer,
      iterations: ENCRYPTION_PARAMS.pbkdf2Iterations,
      hash: ENCRYPTION_PARAMS.pbkdf2Hash
    },
    keyMaterial,
    {
      name: ENCRYPTION_PARAMS.algorithm,
      length: ENCRYPTION_PARAMS.keyLength
    },
    true,  // extractable: must be true to allow exporting for session storage
    ['encrypt', 'decrypt']
  );

  return key;
}

/**
 * Decrypt a message using AES-GCM
 * @param {string} encryptedData - Encrypted message in format: iv:authTag:ciphertext (base64)
 * @param {CryptoKey} key - Derived encryption key
 * @returns {Promise<string>} Decrypted plaintext message
 */
async function decryptMessage(encryptedData, key) {
  try {
    // Parse the encrypted data
    const parts = encryptedData.split(':');
    if (parts.length !== 3) {
      throw new Error('Invalid encrypted data format');
    }

    const iv = Uint8Array.from(atob(parts[0]), c => c.charCodeAt(0));
    const authTag = Uint8Array.from(atob(parts[1]), c => c.charCodeAt(0));
    const ciphertext = Uint8Array.from(atob(parts[2]), c => c.charCodeAt(0));

    // Combine ciphertext and auth tag (Web Crypto API expects them together)
    const encryptedBuffer = new Uint8Array(ciphertext.length + authTag.length);
    encryptedBuffer.set(ciphertext);
    encryptedBuffer.set(authTag, ciphertext.length);

    // Decrypt
    const decrypted = await window.crypto.subtle.decrypt(
      {
        name: ENCRYPTION_PARAMS.algorithm,
        iv: iv,
        tagLength: ENCRYPTION_PARAMS.tagLength
      },
      key,
      encryptedBuffer
    );

    // Convert back to string
    const decoder = new TextDecoder();
    return decoder.decode(decrypted);
  } catch (error) {
    console.error('Decryption failed:', error);
    throw new Error('Failed to decrypt message. Incorrect password or corrupted data.');
  }
}

/**
 * Encrypt a message using AES-GCM
 * @param {string} plaintext - Message to encrypt
 * @param {CryptoKey} key - Derived encryption key
 * @returns {Promise<string>} Encrypted message in format: iv:authTag:ciphertext (base64)
 */
async function encryptMessage(plaintext, key) {
  try {
    const encoder = new TextEncoder();
    const data = encoder.encode(plaintext);

    // Generate random IV
    const iv = window.crypto.getRandomValues(new Uint8Array(ENCRYPTION_PARAMS.ivLength));

    // Encrypt
    const encrypted = await window.crypto.subtle.encrypt(
      {
        name: ENCRYPTION_PARAMS.algorithm,
        iv: iv,
        tagLength: ENCRYPTION_PARAMS.tagLength
      },
      key,
      data
    );

    // Split encrypted data and auth tag
    const encryptedArray = new Uint8Array(encrypted);
    const tagLength = ENCRYPTION_PARAMS.tagLength / 8;
    const ciphertext = encryptedArray.slice(0, -tagLength);
    const authTag = encryptedArray.slice(-tagLength);

    // Convert to base64 and format
    const ivBase64 = btoa(String.fromCharCode.apply(null, iv));
    const authTagBase64 = btoa(String.fromCharCode.apply(null, authTag));
    const ciphertextBase64 = btoa(String.fromCharCode.apply(null, ciphertext));

    return `${ivBase64}:${authTagBase64}:${ciphertextBase64}`;
  } catch (error) {
    console.error('Encryption failed:', error);
    throw new Error('Failed to encrypt message');
  }
}

/**
 * Store encryption key in session storage
 * @param {CryptoKey} key - Encryption key to store
 */
async function storeEncryptionKey(key) {
  // Export key for storage
  const exported = await window.crypto.subtle.exportKey('raw', key);
  const keyArray = Array.from(new Uint8Array(exported));
  const keyBase64 = btoa(String.fromCharCode.apply(null, keyArray));
  sessionStorage.setItem('encryptionKey', keyBase64);
}

/**
 * Retrieve encryption key from session storage
 * @returns {Promise<CryptoKey|null>} Stored encryption key or null
 */
async function getStoredEncryptionKey() {
  const keyBase64 = sessionStorage.getItem('encryptionKey');
  if (!keyBase64) {
    return null;
  }

  try {
    const keyArray = Uint8Array.from(atob(keyBase64), c => c.charCodeAt(0));
    const key = await window.crypto.subtle.importKey(
      'raw',
      keyArray,
      {
        name: ENCRYPTION_PARAMS.algorithm,
        length: ENCRYPTION_PARAMS.keyLength
      },
      false,
      ['encrypt', 'decrypt']
    );
    return key;
  } catch (error) {
    console.error('Failed to retrieve stored key:', error);
    return null;
  }
}

/**
 * Clear stored encryption key
 */
function clearEncryptionKey() {
  sessionStorage.removeItem('encryptionKey');
}

// ============================================================================
// Binary Data Encryption/Decryption (for images and other binary content)
// ============================================================================

/**
 * Convert an ArrayBuffer to a Base64 encoded string
 * @param {ArrayBuffer} buffer - The ArrayBuffer to convert
 * @returns {string} Base64 encoded string
 */
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Convert a Base64 encoded string to an ArrayBuffer
 * @param {string} base64 - The Base64 string to convert
 * @returns {ArrayBuffer} The decoded ArrayBuffer
 */
function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

/**
 * Encrypt binary data (ArrayBuffer) using AES-GCM
 * Uses the same key derivation as text encryption (password + salt + PBKDF2)
 *
 * @param {ArrayBuffer} arrayBuffer - Binary data to encrypt
 * @param {string} password - User's plaintext password
 * @param {string} saltBase64 - Base64 encoded salt
 * @returns {Promise<{ciphertext: ArrayBuffer, iv: Uint8Array, authTag: Uint8Array}>}
 *          Encrypted data with IV and auth tag separated
 * @throws {Error} If encryption fails
 *
 * @example
 * const imageBuffer = await file.arrayBuffer();
 * const { ciphertext, iv, authTag } = await encryptBinary(imageBuffer, password, salt);
 * // Store ciphertext as binary, iv and authTag as base64
 */
async function encryptBinary(arrayBuffer, password, saltBase64) {
  try {
    // Derive key using the same method as text encryption
    const key = await deriveKey(password, saltBase64);

    // Generate random IV (12 bytes for GCM)
    const iv = window.crypto.getRandomValues(new Uint8Array(ENCRYPTION_PARAMS.ivLength));

    // Encrypt the binary data
    const encrypted = await window.crypto.subtle.encrypt(
      {
        name: ENCRYPTION_PARAMS.algorithm,
        iv: iv,
        tagLength: ENCRYPTION_PARAMS.tagLength
      },
      key,
      arrayBuffer
    );

    // Split encrypted data and auth tag
    // Web Crypto API appends the auth tag to the ciphertext
    const encryptedArray = new Uint8Array(encrypted);
    const tagLength = ENCRYPTION_PARAMS.tagLength / 8; // Convert bits to bytes
    const ciphertext = encryptedArray.slice(0, -tagLength);
    const authTag = encryptedArray.slice(-tagLength);

    return {
      ciphertext: ciphertext.buffer,
      iv: iv,
      authTag: authTag
    };
  } catch (error) {
    console.error('Binary encryption failed:', error);
    throw new Error('Failed to encrypt binary data');
  }
}

/**
 * Encrypt binary data using an existing CryptoKey
 * Use this when you already have a derived key (more efficient for multiple encryptions)
 *
 * @param {ArrayBuffer} arrayBuffer - Binary data to encrypt
 * @param {CryptoKey} key - Pre-derived encryption key
 * @returns {Promise<{ciphertext: ArrayBuffer, iv: Uint8Array, authTag: Uint8Array}>}
 *          Encrypted data with IV and auth tag separated
 * @throws {Error} If encryption fails
 */
async function encryptBinaryWithKey(arrayBuffer, key) {
  try {
    // Generate random IV (12 bytes for GCM)
    const iv = window.crypto.getRandomValues(new Uint8Array(ENCRYPTION_PARAMS.ivLength));

    // Encrypt the binary data
    const encrypted = await window.crypto.subtle.encrypt(
      {
        name: ENCRYPTION_PARAMS.algorithm,
        iv: iv,
        tagLength: ENCRYPTION_PARAMS.tagLength
      },
      key,
      arrayBuffer
    );

    // Split encrypted data and auth tag
    const encryptedArray = new Uint8Array(encrypted);
    const tagLength = ENCRYPTION_PARAMS.tagLength / 8;
    const ciphertext = encryptedArray.slice(0, -tagLength);
    const authTag = encryptedArray.slice(-tagLength);

    return {
      ciphertext: ciphertext.buffer,
      iv: iv,
      authTag: authTag
    };
  } catch (error) {
    console.error('Binary encryption failed:', error);
    throw new Error('Failed to encrypt binary data');
  }
}

/**
 * Decrypt binary data (ArrayBuffer) using AES-GCM
 * Uses the same key derivation as text encryption (password + salt + PBKDF2)
 *
 * @param {ArrayBuffer} ciphertext - Encrypted binary data
 * @param {Uint8Array} iv - Initialization vector used during encryption
 * @param {Uint8Array} authTag - Authentication tag for integrity verification
 * @param {string} password - User's plaintext password
 * @param {string} saltBase64 - Base64 encoded salt
 * @returns {Promise<ArrayBuffer>} Decrypted binary data
 * @throws {Error} If decryption fails (wrong password or corrupted data)
 *
 * @example
 * const decryptedBuffer = await decryptBinary(ciphertext, iv, authTag, password, salt);
 * const blob = new Blob([decryptedBuffer], { type: 'image/png' });
 * const imageUrl = URL.createObjectURL(blob);
 */
async function decryptBinary(ciphertext, iv, authTag, password, saltBase64) {
  try {
    // Derive key using the same method as text encryption
    const key = await deriveKey(password, saltBase64);

    // Combine ciphertext and auth tag (Web Crypto API expects them together)
    const ciphertextArray = new Uint8Array(ciphertext);
    const encryptedBuffer = new Uint8Array(ciphertextArray.length + authTag.length);
    encryptedBuffer.set(ciphertextArray);
    encryptedBuffer.set(authTag, ciphertextArray.length);

    // Decrypt
    const decrypted = await window.crypto.subtle.decrypt(
      {
        name: ENCRYPTION_PARAMS.algorithm,
        iv: iv,
        tagLength: ENCRYPTION_PARAMS.tagLength
      },
      key,
      encryptedBuffer
    );

    return decrypted;
  } catch (error) {
    console.error('Binary decryption failed:', error);
    throw new Error('Failed to decrypt binary data. Incorrect password or corrupted data.');
  }
}

/**
 * Decrypt binary data using an existing CryptoKey
 * Use this when you already have a derived key (more efficient for multiple decryptions)
 *
 * @param {ArrayBuffer} ciphertext - Encrypted binary data
 * @param {Uint8Array} iv - Initialization vector used during encryption
 * @param {Uint8Array} authTag - Authentication tag for integrity verification
 * @param {CryptoKey} key - Pre-derived encryption key
 * @returns {Promise<ArrayBuffer>} Decrypted binary data
 * @throws {Error} If decryption fails (wrong key or corrupted data)
 */
async function decryptBinaryWithKey(ciphertext, iv, authTag, key) {
  try {
    // Combine ciphertext and auth tag (Web Crypto API expects them together)
    const ciphertextArray = new Uint8Array(ciphertext);
    const encryptedBuffer = new Uint8Array(ciphertextArray.length + authTag.length);
    encryptedBuffer.set(ciphertextArray);
    encryptedBuffer.set(authTag, ciphertextArray.length);

    // Decrypt
    const decrypted = await window.crypto.subtle.decrypt(
      {
        name: ENCRYPTION_PARAMS.algorithm,
        iv: iv,
        tagLength: ENCRYPTION_PARAMS.tagLength
      },
      key,
      encryptedBuffer
    );

    return decrypted;
  } catch (error) {
    console.error('Binary decryption failed:', error);
    throw new Error('Failed to decrypt binary data. Incorrect key or corrupted data.');
  }
}

/**
 * Serialize encrypted binary data for transmission/storage
 * Converts the encryption result to a format suitable for JSON serialization
 *
 * @param {{ciphertext: ArrayBuffer, iv: Uint8Array, authTag: Uint8Array}} encryptedData
 *        Result from encryptBinary or encryptBinaryWithKey
 * @returns {{ciphertext: string, iv: string, authTag: string}} Base64 encoded components
 */
function serializeEncryptedBinary(encryptedData) {
  return {
    ciphertext: arrayBufferToBase64(encryptedData.ciphertext),
    iv: arrayBufferToBase64(encryptedData.iv.buffer),
    authTag: arrayBufferToBase64(encryptedData.authTag.buffer)
  };
}

/**
 * Deserialize encrypted binary data from transmission/storage format
 * Converts Base64 encoded components back to binary format for decryption
 *
 * @param {{ciphertext: string, iv: string, authTag: string}} serializedData
 *        Base64 encoded encryption components
 * @returns {{ciphertext: ArrayBuffer, iv: Uint8Array, authTag: Uint8Array}} Binary components
 */
function deserializeEncryptedBinary(serializedData) {
  return {
    ciphertext: base64ToArrayBuffer(serializedData.ciphertext),
    iv: new Uint8Array(base64ToArrayBuffer(serializedData.iv)),
    authTag: new Uint8Array(base64ToArrayBuffer(serializedData.authTag))
  };
}

// Export functions
window.E2EEncryption = {
  // Text encryption (existing)
  deriveKey,
  encryptMessage,
  decryptMessage,
  storeEncryptionKey,
  getStoredEncryptionKey,
  clearEncryptionKey,

  // Binary encryption (new)
  encryptBinary,
  encryptBinaryWithKey,
  decryptBinary,
  decryptBinaryWithKey,

  // Utility functions (new)
  arrayBufferToBase64,
  base64ToArrayBuffer,
  serializeEncryptedBinary,
  deserializeEncryptedBinary,

  // Constants (useful for external code)
  ENCRYPTION_PARAMS
};
