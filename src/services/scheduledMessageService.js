const fs = require('fs');
const path = require('path');
const { getClient } = require('../db/connection');
const chatThreadService = require('../shared/chatThreadService');
const { sanitizeFolderName, getChatspaceRoot } = require('./agentSpawnService');

const DELIVERY_INTERVAL_MS = 15_000;
let deliveryTimer = null;

function signalAgent(agentName) {
  try {
    const signalPath = path.join(getChatspaceRoot(), sanitizeFolderName(agentName), 'agent_state', '.message_pending');
    fs.writeFileSync(signalPath, `from=user\ntime=${new Date().toISOString()}\n`);
  } catch (_) {
    // The normal polling interval will still deliver the message.
  }
}

async function deliverDueScheduledMessages() {
  const client = await getClient();
  const delivered = [];
  try {
    await client.query('BEGIN');
    const due = await client.query(
      `SELECT sm.scheduled_message_id, sm.agent_id, sm.content, sm.encrypted, sm.run_overrides, a.agent_name, a.user_id AS owner_id
       FROM scheduled_user_messages sm
       JOIN agents a ON a.agent_id = sm.agent_id
       WHERE sm.delivered_at IS NULL AND sm.scheduled_for <= NOW()::timestamp
       ORDER BY sm.scheduled_for ASC
       FOR UPDATE`
    );
    for (const scheduled of due.rows) {
      if (process.env.FEATURE_IN_PLACE_AGENT_SHARING === 'true') {
        await client.query('SELECT agent_id FROM agents WHERE agent_id=$1 AND user_id=$2 FOR UPDATE', [scheduled.agent_id,scheduled.owner_id]);
        try { await chatThreadService.assertPrivateThreadWritable(client,scheduled.agent_id,scheduled.owner_id); }
        catch (error) { if (error.status===409) continue; throw error; }
      }
      await client.query(
        'INSERT INTO user_messages (agent_id, content, encrypted, run_overrides) VALUES ($1, $2, $3, $4::jsonb)',
        [scheduled.agent_id, scheduled.content, scheduled.encrypted, scheduled.run_overrides ? JSON.stringify(scheduled.run_overrides) : null]
      );
      await client.query(
        'UPDATE scheduled_user_messages SET delivered_at = NOW() WHERE scheduled_message_id = $1',
        [scheduled.scheduled_message_id]
      );
      delivered.push(scheduled.agent_name);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  delivered.forEach(signalAgent);
  return delivered.length;
}

function startScheduledMessageDelivery() {
  if (deliveryTimer) return deliveryTimer;
  const run = () => deliverDueScheduledMessages().catch((error) => {
    console.error('Scheduled message delivery failed:', error.message);
  });
  run();
  deliveryTimer = setInterval(run, DELIVERY_INTERVAL_MS);
  deliveryTimer.unref?.();
  return deliveryTimer;
}

module.exports = { deliverDueScheduledMessages, startScheduledMessageDelivery, signalAgent };
