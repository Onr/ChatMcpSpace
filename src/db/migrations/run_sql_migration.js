const fs = require('fs');
const path = require('path');
// Load environment variables from the root .env file
require('dotenv').config({ path: path.resolve(__dirname, '../../../.env') });
const { query, getClient } = require('../connection');

async function runMigrationFile(filename) {
    const client = await getClient();
    const filePath = path.join(__dirname, filename);

    try {
        console.log(`Running migration: ${filename}...`);
        const sql = fs.readFileSync(filePath, 'utf8');

        await client.query('BEGIN');
        await client.query(sql);
        await client.query('COMMIT');

        console.log(`✓ Migration ${filename} completed successfully`);
    } catch (error) {
        await client.query('ROLLBACK');
        console.error(`✗ Migration ${filename} failed:`, error);
        process.exit(1);
    } finally {
        client.release();
    }
}

const filename = process.argv[2];
if (!filename) {
    console.error('Please specify a migration file to run');
    process.exit(1);
}

runMigrationFile(filename).then(() => {
    process.exit(0);
});
