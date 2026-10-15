'use strict';

const crypto = require('crypto');
const { setTimeout: delay } = require('timers/promises');

function canonical(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' ||
      typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) throw Error('Invalid bound action parameters');
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
}
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function actionDigest(context, descriptor) {
  return hash(canonical({ taskId: context.request.taskId, grantId: context.authorization.grantId,
    revision: context.authorization.policyRevision, deviceId: context.execution.executorId,
    deviceEpoch: context.authorization.deviceEpoch, action: descriptor }));
}

// One coarse workspace execution, not permission to bypass per-tool approvals.
// All native/provider tool mediation still needs its own reviewed boundary.
class BoundActionBroker {
  constructor({ context, record, persist, api, signal, confirmedStopped, wait = delay }) {
    this.context = context;
    this.record = record;
    this.persist = persist;
    this.api = api;
    this.signal = signal;
    this.confirmedStopped = confirmedStopped;
    this.wait = wait;
  }

  checkSignal() { this.signal?.throwIfAborted(); }

  validate(reply, { started = false } = {}) {
    const { descriptor, actionId, digest } = this.record;
    if (!reply || reply.actionId !== actionId || reply.taskId !== this.context.request.taskId || reply.digest !== digest ||
        reply.name !== descriptor.name || reply.resource !== descriptor.resource || reply.destination !== descriptor.destination ||
        !['pending', 'approved', 'not_required', 'denied', 'revoked'].includes(reply.approvalState) ||
        typeof reply.expiresAt !== 'string' || !Number.isFinite(Date.parse(reply.expiresAt))) throw Error('Action response does not match the bound execution');
    if (Date.parse(reply.expiresAt) <= Date.now()) throw Error('Bound action has expired');
    if (started) {
      if (!['approved', 'not_required'].includes(reply.approvalState) || reply.outcome !== 'running' ||
          typeof reply.executionNonce !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(reply.executionNonce)) {
        throw Error('Action start was not confirmed; inspect its receipt without replaying');
      }
    } else if (reply.outcome || reply.executionNonce) throw Error('Action was already consumed; inspect its receipt without replaying');
    return reply;
  }

  async run(descriptor, execute) {
    this.checkSignal();
    if (this.record.phase) throw Error('An earlier bound action requires review; execution cannot be replayed');
    // Snapshot before the first await. The owner approves these exact values.
    descriptor = JSON.parse(JSON.stringify(descriptor));
    if (Buffer.byteLength(canonical(descriptor)) > 16000) throw Error('Bound execution parameters exceed 16 KB');
    Object.assign(this.record, { phase: 'proposing', actionId: crypto.randomUUID(), descriptor,
      digest: actionDigest(this.context, descriptor) });
    this.persist();
    const route = `/tasks/${this.context.request.taskId}/actions`;
    const body = { actionId: this.record.actionId, ...descriptor };
    let reply = this.validate(await this.api(route, body));
    while (reply.approvalState === 'pending') {
      this.record.phase = 'waiting_for_approval'; this.persist();
      this.checkSignal();
      await this.wait(Math.min(1000, Math.max(1, Date.parse(reply.expiresAt) - Date.now())), undefined, { signal: this.signal });
      this.checkSignal();
      // The same operation ID is an idempotent status read, never a new action.
      reply = this.validate(await this.api(route, body));
    }
    if (!['approved', 'not_required'].includes(reply.approvalState)) throw Error('Owner approval was denied or revoked');
    this.checkSignal();
    // Persist intent before requesting consumption. A lost reply must never
    // cause automatic re-consumption or execution, even after restart.
    this.record.phase = 'start_pending'; this.persist();
    reply = this.validate(await this.api(`${route}/${this.record.actionId}/start`, { digest: this.record.digest }), { started: true });
    this.record.phase = 'executing'; this.record.executionNonce = reply.executionNonce; this.persist();
    const startedAt = Date.now();
    let output, failure;
    try { this.checkSignal(); output = await execute(); }
    catch (error) { failure = error; }
    let stopped = false;
    try { stopped = this.confirmedStopped() === true; } catch (_) { /* Missing observation is not absence proof. */ }
    if (!stopped && !failure) {
      failure = Object.assign(Error('Execution returned output without confirmed process stoppage; preserve the receipt for review'),
        { code: 'RESTRICTED_CANCEL_UNCERTAIN' });
    }
    this.record.completion = { executionNonce: this.record.executionNonce,
      outcome: failure ? stopped ? 'failed' : 'outcome_uncertain' : 'succeeded',
      receipt: { durationMs: Math.max(0, Date.now() - startedAt), confirmedStopped: stopped,
        ...(typeof output === 'string' ? { outputHash: hash(output) } : {}) } };
    this.record.phase = 'receipt_pending'; this.persist();
    try { await this.flushReceipt(); }
    catch (error) {
      if (!failure) throw error;
      const combined = new AggregateError([failure, error], 'Execution and action acknowledgement require review');
      for (const key of ['code', 'containerId', 'containerName', 'retainedEngineConfiguration']) {
        if (failure[key] !== undefined) combined[key] = failure[key];
      }
      throw combined;
    }
    if (failure) throw failure;
    return output;
  }

  async flushReceipt() {
    if (this.record.phase !== 'receipt_pending') return;
    const receipt = this.record.completion;
    if (!receipt || receipt.executionNonce !== this.record.executionNonce) throw Error('Bound action receipt is incomplete; preserve it for review');
    const reply = await this.api(`/tasks/${this.context.request.taskId}/actions/${this.record.actionId}/complete`, receipt);
    // Expired/revoked tasks may acknowledge a retained outcome. Do not apply
    // current execution permission to this recovery-only acknowledgement.
    if (reply?.actionId !== this.record.actionId || reply.taskId !== this.context.request.taskId ||
        reply.digest !== this.record.digest || reply.executionNonce !== this.record.executionNonce ||
        reply.outcome !== receipt.outcome || canonical(reply.receipt) !== canonical(receipt.receipt)) {
      throw Error('Action receipt acknowledgement does not match the retained outcome');
    }
    this.record.phase = 'completed'; this.persist();
  }
}

module.exports = { BoundActionBroker, actionDigest, canonical, hash };
