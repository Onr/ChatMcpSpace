const fs = require('fs');
const path = require('path');
const { getClient } = require('../db/connection');
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
      `SELECT sm.scheduled_message_id, sm.agent_id, sm.content, sm.encrypted, a.agent_name
       FROM scheduled_user_messages sm
       JOIN agents a ON a.agent_id = sm.agent_id
       WHERE sm.delivered_at IS NULL AND sm.scheduled_for <= NOW()::timestamp
       ORDER BY sm.scheduled_for ASC
       FOR UPDATE`
    );
    for (const scheduled of due.rows) {
      await client.query(
        'INSERT INTO user_messages (agent_id, content, encrypted) VALUES ($1, $2, $3)',
        [scheduled.agent_id, scheduled.content, scheduled.encrypted]
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
