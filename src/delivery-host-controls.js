'use strict';

const CONTROL_FIELDS = Object.freeze([
  'runId', 'projectId', 'sessionId', 'objectiveId', 'messageId', 'text',
  'expectedPlanRevision', 'expectedGoalRevision', 'expectedControlRevision',
]);
const SCOPE_ID = /^[\x21-\x7e]{1,128}$/;
const express = require('express');

function responseError(res, status, error) {
  return res.status(status).json({ error });
}

function validSteeringBody(body, runId, projectId) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const keys = Object.keys(body);
  if (keys.length !== CONTROL_FIELDS.length || keys.some((key) => !CONTROL_FIELDS.includes(key))) return false;
  if (CONTROL_FIELDS.some((key) => !Object.hasOwn(body, key))) return false;
  if (body.runId !== runId || body.projectId !== projectId || !SCOPE_ID.test(body.runId)
    || !SCOPE_ID.test(body.sessionId) || !SCOPE_ID.test(body.objectiveId) || !SCOPE_ID.test(body.messageId)) return false;
  if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 2000) return false;
  return ['expectedPlanRevision', 'expectedGoalRevision', 'expectedControlRevision']
    .every((key) => Number.isSafeInteger(body[key]) && body[key] >= 0);
}

function validDecisionBody(body, runId, projectId, replace) {
  const fields = ['runId', 'projectId', 'sessionId', 'objectiveId', 'messageId', 'decisionId',
    ...(replace ? ['oldRequestDigest', 'replacement'] : ['requestDigest', 'optionId']),
    'expectedPlanRevision', 'expectedGoalRevision', 'expectedAuthorityRevision', 'expectedControlRevision', 'expectedOwnerGeneration'];
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== fields.length
    || fields.some((key) => !Object.hasOwn(body, key)) || Object.keys(body).some((key) => !fields.includes(key))) return false;
  if (body.runId !== runId || body.projectId !== projectId) return false;
  if (['runId', 'projectId', 'sessionId', 'objectiveId', 'messageId', 'decisionId'].some((key) => typeof body[key] !== 'string' || !SCOPE_ID.test(body[key]))) return false;
  if (!/^sha256:[a-f0-9]{64}$/.test(body[replace ? 'oldRequestDigest' : 'requestDigest'])) return false;
  if (!replace && (typeof body.optionId !== 'string' || !SCOPE_ID.test(body.optionId))) return false;
  return fields.filter((key) => key.startsWith('expected')).every((key) => Number.isSafeInteger(body[key]) && body[key] >= 0);
}

function registerDeliveryHostControls(app, { authMiddleware, router } = {}) {
  if (!app || typeof app.get !== 'function' || typeof app.post !== 'function') throw new TypeError('An Express-compatible app is required');
  if (typeof authMiddleware !== 'function') throw new TypeError('A host authentication middleware is required');

  app.get('/control/delivery/:runId', authMiddleware, (req, res) => {
    const runId = req.params?.runId;
    const mapping = router?.mapping?.(runId);
    if (!mapping || mapping.runId !== runId) return responseError(res, 404, 'delivery_run_not_found');
    if (mapping.engine !== 'concurrent-v1') return responseError(res, 503, 'delivery_engine_unsupported');
    if (!router.concurrentEngine || typeof router.concurrentEngine.controlStatus !== 'function'
      || typeof router.concurrentEngine.steer !== 'function') return responseError(res, 503, 'delivery_control_unavailable');
    if (!mapping.projectId || !mapping.sessionId || !mapping.objectiveId) return responseError(res, 404, 'delivery_run_not_found');
    try {
      const status = router.concurrentEngine.controlStatus(runId);
      if (!status || status.runId !== runId || status.projectId !== mapping.projectId
        || status.sessionId !== mapping.sessionId || status.objectiveId !== mapping.objectiveId) {
        return responseError(res, 404, 'delivery_run_not_found');
      }
      return res.json(status);
    } catch (_) {
      return responseError(res, 503, 'delivery_control_unavailable');
    }
  });

  for (const replace of [false, true]) {
    app.post(`/control/delivery/:runId/decision${replace ? '/replace' : ''}`, authMiddleware, express.json({ limit: '16kb', strict: true }), async (req, res) => {
      const runId = req.params?.runId;
      if (!validDecisionBody(req.body, runId, router?.projectId, replace)) return responseError(res, 400, 'owner_decision_request_invalid');
      const mapping = router?.mapping?.(runId);
      if (!mapping || mapping.runId !== runId) return responseError(res, 404, 'delivery_run_not_found');
      if (mapping.engine !== 'concurrent-v1') return responseError(res, 503, 'delivery_engine_unsupported');
      if (mapping.projectId !== req.body.projectId || mapping.sessionId !== req.body.sessionId || mapping.objectiveId !== req.body.objectiveId) return responseError(res, 409, 'owner_decision_scope_mismatch');
      if (typeof router.concurrentEngine?.controlOwnerDecision !== 'function') return responseError(res, 503, 'delivery_control_unavailable');
      try {
        const result = await router.concurrentEngine.controlOwnerDecision(req.body, { replace });
        if (!result || result.acknowledged !== true || result.messageId !== req.body.messageId || result.runId !== runId
          || result.projectId !== mapping.projectId || result.sessionId !== mapping.sessionId || result.objectiveId !== mapping.objectiveId
          || result.state !== (replace ? 'replaced' : 'resolved')) return responseError(res, 503, 'delivery_control_unavailable');
        return res.json(result);
      } catch (error) {
        if (error?.code === 'owner_decision_unauthorized') return responseError(res, 403, error.code);
        if (error?.code === 'message_id_conflict' || /(?:stale|controlled|conflict|scope_mismatch|pending)$/.test(error?.code || '')) return responseError(res, 409, error.code);
        if (error?.code?.startsWith('owner_decision_')) return responseError(res, 400, error.code);
        return responseError(res, 503, 'delivery_control_unavailable');
      }
    });
  }

  app.post('/control/delivery/:runId/steer', authMiddleware, express.json({ limit: '16kb', strict: true }), async (req, res) => {
    const runId = req.params?.runId;
    if (!validSteeringBody(req.body, runId, router?.projectId)) return responseError(res, 400, 'steer_request_invalid');
    const mapping = router?.mapping?.(runId);
    if (!mapping || mapping.runId !== runId) return responseError(res, 404, 'delivery_run_not_found');
    if (mapping.engine !== 'concurrent-v1') return responseError(res, 503, 'delivery_engine_unsupported');
    if (!router.concurrentEngine || typeof router.concurrentEngine.controlStatus !== 'function'
      || typeof router.concurrentEngine.steer !== 'function') return responseError(res, 503, 'delivery_control_unavailable');
    if (mapping.projectId !== req.body.projectId || mapping.sessionId !== req.body.sessionId
      || mapping.objectiveId !== req.body.objectiveId) return responseError(res, 409, 'steer_scope_mismatch');
    try {
      const status = router.concurrentEngine.controlStatus(runId);
      if (!status || status.runId !== runId || status.projectId !== mapping.projectId
        || status.sessionId !== mapping.sessionId || status.objectiveId !== mapping.objectiveId) {
        return responseError(res, 404, 'delivery_run_not_found');
      }
      const acknowledgement = await router.concurrentEngine.steer(req.body);
      if (!acknowledgement || acknowledgement.runId !== runId || acknowledgement.projectId !== mapping.projectId
        || acknowledgement.sessionId !== mapping.sessionId || acknowledgement.objectiveId !== mapping.objectiveId
        || acknowledgement.messageId !== req.body.messageId || acknowledgement.acknowledged !== true
        || !['received', 'applied', 'blocked'].includes(acknowledgement.state)) {
        return responseError(res, 503, 'delivery_control_unavailable');
      }
      return res.json(acknowledgement);
    } catch (error) {
      if (error?.code === 'steer_revision_stale') return responseError(res, 409, error.code);
      if (error?.code === 'steer_scope_mismatch' || error?.code === 'steer_run_not_active'
        || error?.code === 'message_id_conflict') return responseError(res, 409, error.code);
      if (error?.code === 'steer_text_invalid' || error?.code === 'steer_fields_invalid') return responseError(res, 400, error.code);
      return responseError(res, 503, 'delivery_control_unavailable');
    }
  });
}

module.exports = { CONTROL_FIELDS, registerDeliveryHostControls };
