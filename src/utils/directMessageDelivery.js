// A successful send stores a message; only the recipient can confirm receipt.
function directMessageDelivery(lastSeenAt, readAt = null, now = Date.now()) {
  const lastSeen = lastSeenAt ? new Date(lastSeenAt).getTime() : NaN;
  return {
    state: readAt ? 'received' : 'pending',
    readAt: readAt ? new Date(readAt).toISOString() : null,
    recipientOnline: Number.isFinite(lastSeen) && now - lastSeen < 300000,
    recipientLastSeenAt: Number.isFinite(lastSeen) ? new Date(lastSeen).toISOString() : null
  };
}

module.exports = { directMessageDelivery };
