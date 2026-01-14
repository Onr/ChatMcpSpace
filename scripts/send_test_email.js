const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const { query, closePool } = require('../src/db/connection');
const { sendVerificationEmail, generateVerificationEmailHtml, createVerificationToken } = require('../src/services/emailService');
const fs = require('fs');

async function main() {
  try {
    const targetEmail = process.argv[2];
    
    console.log('Starting test email script...');

    // 1. Find a user
    let user;
    const userResult = await query('SELECT * FROM users LIMIT 1');
    
    if (userResult.rows.length > 0) {
      user = userResult.rows[0];
      console.log(`Found existing user: ${user.email} (${user.user_id})`);
    } else {
      console.log('No users found. Creating a temporary test user...');
      // Create a dummy user
      const dummyEmail = targetEmail || 'test@example.com';
      const result = await query(
        `INSERT INTO users (email, password_hash, api_key, encryption_salt)
         VALUES ($1, 'dummy_hash', 'dummy_key_' || gen_random_uuid(), 'dummy_salt')
         RETURNING *`,
        [dummyEmail]
      );
      user = result.rows[0];
      console.log(`Created test user: ${user.email} (${user.user_id})`);
    }

    // 2. Generate HTML preview
    console.log('Generating HTML preview...');
    const token = await createVerificationToken(user.user_id);
    const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
    const verificationUrl = `${baseUrl}/verify-email?token=${token}`;
    const html = generateVerificationEmailHtml(verificationUrl, targetEmail || user.email);
    
    const previewPath = path.join(__dirname, '../test_email_preview.html');
    fs.writeFileSync(previewPath, html);
    console.log(`HTML preview saved to: ${previewPath}`);

    // 3. Send email if address provided
    if (targetEmail) {
      console.log(`Sending verification email to ${targetEmail}...`);
      const result = await sendVerificationEmail(user.user_id, targetEmail);
      console.log('Send result:', result);
    } else {
      console.log('No target email provided. Skipping actual send.');
      console.log('Usage: node scripts/send_test_email.js <email_address>');
    }

  } catch (error) {
    console.error('Error:', error);
  } finally {
    await closePool();
  }
}

main();
