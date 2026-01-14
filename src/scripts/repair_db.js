// Force using postgres user for schema changes
process.env.DB_USER = 'postgres';
delete process.env.DB_PASSWORD;
delete process.env.DB_HOST;
delete process.env.DB_PORT;

require('dotenv').config();

// Override again just in case dotenv overwrote it
process.env.DB_USER = 'postgres';
delete process.env.DB_PASSWORD;

const { query, pool } = require('../db/connection');

async function repairDatabase() {
    const client = await pool.connect();

    try {
        console.log('Starting database repair...');
        await client.query('BEGIN');

        // 1. Delete orphaned records
        console.log('Deleting orphaned records...');

        // Delete orphaned user_messages (agent_id not in agents)
        const umResult = await client.query(`
      DELETE FROM user_messages 
      WHERE agent_id NOT IN (SELECT agent_id FROM agents)
    `);
        console.log(`Deleted ${umResult.rowCount} orphaned user_messages`);

        // Delete orphaned user_responses (message_id not in messages)
        const urResult = await client.query(`
      DELETE FROM user_responses 
      WHERE message_id NOT IN (SELECT message_id FROM messages)
    `);
        console.log(`Deleted ${urResult.rowCount} orphaned user_responses`);

        // Delete orphaned question_options (message_id not in messages)
        const qoResult = await client.query(`
      DELETE FROM question_options 
      WHERE message_id NOT IN (SELECT message_id FROM messages)
    `);
        console.log(`Deleted ${qoResult.rowCount} orphaned question_options`);

        // Delete orphaned messages (agent_id not in agents)
        const mResult = await client.query(`
      DELETE FROM messages 
      WHERE agent_id NOT IN (SELECT agent_id FROM agents)
    `);
        console.log(`Deleted ${mResult.rowCount} orphaned messages`);

        // 2. Drop existing constraints if they exist (to be safe)
        console.log('Dropping existing constraints...');

        await client.query(`
      ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_agent_id_fkey;
      ALTER TABLE question_options DROP CONSTRAINT IF EXISTS question_options_message_id_fkey;
      ALTER TABLE user_responses DROP CONSTRAINT IF EXISTS user_responses_message_id_fkey;
      ALTER TABLE user_responses DROP CONSTRAINT IF EXISTS user_responses_option_id_fkey;
      ALTER TABLE user_messages DROP CONSTRAINT IF EXISTS user_messages_agent_id_fkey;
    `);

        // 3. Re-add constraints with ON DELETE CASCADE
        console.log('Restoring constraints with ON DELETE CASCADE...');

        await client.query(`
      ALTER TABLE messages 
      ADD CONSTRAINT messages_agent_id_fkey 
      FOREIGN KEY (agent_id) REFERENCES agents(agent_id) ON DELETE CASCADE;
    `);

        await client.query(`
      ALTER TABLE question_options 
      ADD CONSTRAINT question_options_message_id_fkey 
      FOREIGN KEY (message_id) REFERENCES messages(message_id) ON DELETE CASCADE;
    `);

        await client.query(`
      ALTER TABLE user_responses 
      ADD CONSTRAINT user_responses_message_id_fkey 
      FOREIGN KEY (message_id) REFERENCES messages(message_id) ON DELETE CASCADE;
    `);

        await client.query(`
      ALTER TABLE user_responses 
      ADD CONSTRAINT user_responses_option_id_fkey 
      FOREIGN KEY (option_id) REFERENCES question_options(option_id) ON DELETE CASCADE;
    `);

        await client.query(`
      ALTER TABLE user_messages 
      ADD CONSTRAINT user_messages_agent_id_fkey 
      FOREIGN KEY (agent_id) REFERENCES agents(agent_id) ON DELETE CASCADE;
    `);

        await client.query('COMMIT');
        console.log('Database repair completed successfully!');

    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Error repairing database:', err);
    } finally {
        client.release();
        pool.end();
    }
}

repairDatabase();
