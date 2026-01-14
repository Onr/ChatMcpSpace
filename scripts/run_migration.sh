require('dotenv').config();
const { query, closePool } = require('../src/db/connection');

async function runMigration() {
  try {
    console.log('\n=== Running Read Tracking Migration ===\n');
    
    console.log('1. Adding read_at to messages table...');
    await query('ALTER TABLE messages ADD COLUMN IF NOT EXISTS read_at TIMESTAMP DEFAULT NULL');
    console.log('   ✓ Complete');
    
    console.log('2. Adding read_at to user_messages table...');
    await query('ALTER TABLE user_messages ADD COLUMN IF NOT EXISTS read_at TIMESTAMP DEFAULT NULL');
    console.log('   ✓ Complete');
    
    console.log('3. Creating index on messages.read_at...');
    await query('CREATE INDEX IF NOT EXISTS idx_messages_read_at ON messages(read_at)');
    console.log('   ✓ Complete');
    
    console.log('4. Creating index on user_messages.read_at...');
    await query('CREATE INDEX IF NOT EXISTS idx_user_messages_read_at ON user_messages(read_at)');
    console.log('   ✓ Complete');
    
    console.log('\n✅ Migration completed successfully!\n');
    process.exit(0);
  } catch (error) {
    console.error('\n❌ Migration failed:', error.message);
    console.error('Error details:', error);
    process.exit(1);
  } finally {
    await closePool();
  }
}

runMigration();

