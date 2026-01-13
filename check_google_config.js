
const fs = require('fs');
const path = require('path');
require('dotenv').config();

console.log('Checking Google OAuth Configuration...');

const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
const callbackUrl = process.env.GOOGLE_CALLBACK_URL;

console.log(`GOOGLE_CLIENT_ID is set: ${!!clientId && clientId !== 'dummy_client_id'}`);
console.log(`GOOGLE_CLIENT_ID has whitespace: ${clientId !== clientId.trim()}`);
console.log(`GOOGLE_CLIENT_SECRET is set: ${!!clientSecret && clientSecret !== 'dummy_client_secret'}`);
console.log(`GOOGLE_CLIENT_SECRET has whitespace: ${clientSecret !== clientSecret.trim()}`);
console.log(`GOOGLE_CALLBACK_URL: ${callbackUrl}`);
console.log(`GOOGLE_CALLBACK_URL has whitespace: ${callbackUrl !== callbackUrl.trim()}`);

if (!clientId || clientId === 'dummy_client_id') {
    console.error('ERROR: GOOGLE_CLIENT_ID is missing or default.');
}
if (!clientSecret || clientSecret === 'dummy_client_secret') {
    console.error('ERROR: GOOGLE_CLIENT_SECRET is missing or default.');
}

console.log('Done.');
