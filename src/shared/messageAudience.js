'use strict';

async function hasAudience(client) {
  return (await client.query(`SELECT column_name FROM information_schema.columns
    WHERE table_schema=current_schema() AND table_name='shared_messages' AND column_name='recipient_principals'`)).rows.length > 0;
}

function visibleTo(message, principal) {
  const recipients = message.recipient_principals || [];
  return !recipients.length || recipients.some(target => target.kind === principal.kind && target.id === principal.id);
}

async function visibilityFilter(client, principal, parameter = 3, alias = 'm') {
  if (!principal || !await hasAudience(client)) return '';
  return `AND (${alias}.recipient_principals='[]'::jsonb OR ${alias}.recipient_principals @> $${parameter}::jsonb)`;
}

async function visibleMessage(client, roomId, messageId, principal) {
  const filter = await visibilityFilter(client, principal);
  return (await client.query(`SELECT m.id FROM shared_messages m WHERE m.conversation_id=$1 AND m.id=$2 ${filter}`,
    [roomId, messageId, ...(filter ? [JSON.stringify([principal])] : [])])).rows[0];
}

module.exports = { hasAudience, visibleTo, visibilityFilter, visibleMessage };
