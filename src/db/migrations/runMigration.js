/**
 * Database Migration Runner
 * Adds encryption_salt to existing users
 */

const { query, getClient } = require('../connection');
const { generateEncryptionSalt } = require('../../utils/encryptionHelper');

async function migrateAddEncryptionSalt() {
  const client = await getClient();
  
  try {
    console.log('Starting migration: Add encryption_salt to users...');
    
    await client.query('BEGIN');
    
    // Add column if it doesn't exist
    await client.query(`
      ALTER TABLE users 
      ADD COLUMN IF NOT EXISTS encryption_salt VARCHAR(255)
    `);
    
    // Find users without encryption_salt
    const usersWithoutSalt = await client.query(`
      SELECT user_id, email 
      FROM users 
      WHERE encryption_salt IS NULL
    `);
    
    console.log(`Found ${usersWithoutSalt.rows.length} users without encryption_salt`);
    
    // Generate salt for each user
    for (const user of usersWithoutSalt.rows) {
      const salt = generateEncryptionSalt();
      await client.query(
        'UPDATE users SET encryption_salt = $1 WHERE user_id = $2',
        [salt, user.user_id]
      );
      console.log(`Generated encryption_salt for user: ${user.email}`);
    }
    
    // Make encryption_salt NOT NULL after populating existing users
    await client.query(`
      ALTER TABLE users 
      ALTER COLUMN encryption_salt SET NOT NULL
    `);
    
    await client.query('COMMIT');
    
    console.log('✓ Migration completed successfully');
    return true;
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('✗ Migration failed:', error);
    throw error;
  } finally {
    client.release();
  }
}

// Run migration if called directly
if (require.main === module) {
  migrateAddEncryptionSalt()
    .then(() => {
      console.log('Migration finished');
      process.exit(0);
    })
    .catch((error) => {
      console.error('Migration error:', error);
      process.exit(1);
    });
}

module.exports = { migrateAddEncryptionSalt };
