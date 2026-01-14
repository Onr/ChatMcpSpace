require('dotenv').config();
const db = require('./src/db/connection');

async function checkDatabase() {
    try {
        // Check if encrypted column exists
        const columnCheck = await db.query(`
            SELECT column_name, data_type, is_nullable
            FROM information_schema.columns 
            WHERE table_name = 'messages' 
            AND column_name = 'encrypted'
        `);
        
        console.log('\n=== Messages Table - encrypted column ===');
        if (columnCheck.rows.length > 0) {
            console.log('✓ Column exists:', columnCheck.rows[0]);
        } else {
            console.log('✗ Column does NOT exist');
        }
        
        // Check user_messages table
        const userMsgCheck = await db.query(`
            SELECT column_name, data_type, is_nullable
            FROM information_schema.columns 
            WHERE table_name = 'user_messages' 
            AND column_name = 'encrypted'
        `);
        
        console.log('\n=== User_Messages Table - encrypted column ===');
        if (userMsgCheck.rows.length > 0) {
            console.log('✓ Column exists:', userMsgCheck.rows[0]);
        } else {
            console.log('✗ Column does NOT exist');
        }
        
        // Check migrations
        const migrations = await db.query(`
            SELECT * FROM migrations 
            ORDER BY applied_at DESC 
            LIMIT 5
        `);
        
        console.log('\n=== Recent Migrations ===');
        migrations.rows.forEach(m => {
            console.log(`- ${m.migration_name} (${m.applied_at})`);
        });
        
        await db.end();
        process.exit(0);
    } catch (error) {
        console.error('Error:', error.message);
        await db.end();
        process.exit(1);
    }
}

checkDatabase();
